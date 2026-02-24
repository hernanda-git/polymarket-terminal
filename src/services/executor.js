import { Side, OrderType } from '@polymarket/clob-client';
import config from '../config/index.js';
import { getClient, getUsdcBalance } from './client.js';
import { hasPosition, addPosition, getPosition, updatePosition, removePosition } from './position.js';
import { fetchMarketByTokenId } from './watcher.js';
import { placeAutoSell } from './autoSell.js';
import { recordSimBuy } from '../utils/simStats.js';
import logger from '../utils/logger.js';

// Once the first BUY trade is successfully executed, we lock onto that
// market/condition and ignore all other markets (both buys and sells).
let mainConditionId = null;

// Timestamp of last successful BUY (dry or live). Used to skip buys if we already bought within 1 minute.
const BUY_COOLDOWN_MS = 60_000; // 1 minute
let lastBuyTimestamp = 0;

/**
 * Get market options (tick size and neg risk) for a token
 */
async function getMarketOptions(tokenId) {
    const client = getClient();
    try {
        // Try to get from market info
        const marketInfo = await fetchMarketByTokenId(tokenId);
        if (marketInfo) {
            return {
                tickSize: String(marketInfo.minimum_tick_size || '0.01'),
                negRisk: marketInfo.neg_risk || false,
                conditionId: marketInfo.condition_id || '',
                question: marketInfo.question || '',
            };
        }
    } catch (err) {
        logger.warn('Failed to get market info, using defaults:', err.message);
    }

    // Fallback: try SDK methods
    try {
        const tickSize = await client.getTickSize(tokenId);
        const negRisk = await client.getNegRisk(tokenId);
        return { tickSize: String(tickSize), negRisk, conditionId: '', question: '' };
    } catch (err) {
        logger.warn('Failed to get tick size from SDK, using default 0.01');
        return { tickSize: '0.01', negRisk: false, conditionId: '', question: '' };
    }
}

/**
 * Execute a BUY trade (copy trader's buy)
 * @param {Object} trade - Trade info from watcher
 */
export async function executeBuy(trade) {
    const { tokenId, conditionId, market, price, size } = trade;

    // Get market options first to resolve conditionId
    const marketOpts = await getMarketOptions(tokenId);
    const effectiveConditionId = conditionId || marketOpts.conditionId;

    // If we've already locked onto a main topic, ignore buys from all other markets.
    if (mainConditionId && effectiveConditionId && effectiveConditionId !== mainConditionId) {
        return;
    }

    // At most 1 buy per minute — skip if we already bought within the last minute.
    const now = Date.now();
    if (lastBuyTimestamp > 0 && now - lastBuyTimestamp < BUY_COOLDOWN_MS) {
        logger.info(
            `Skipping buy: already had 1 buy in the last minute (${Math.round((BUY_COOLDOWN_MS - (now - lastBuyTimestamp)) / 1000)}s cooldown left).`,
        );
        return;
    }

    // Check existing position and max position size cap
    const existingPos = getPosition(effectiveConditionId);
    if (existingPos) {
        const spent = existingPos.totalCost || 0;
        if (spent >= config.maxPositionSize) {
            logger.warn(`Max position $${config.maxPositionSize} reached for: ${market || effectiveConditionId} (spent $${spent.toFixed(2)}). Skipping.`);
            return;
        }
        logger.info(`Adding to existing position (spent $${spent.toFixed(2)} / $${config.maxPositionSize})`);
    }

    // Remaining capacity for this market based on maxPositionSize
    const remainingCap = existingPos
        ? Math.max(config.maxPositionSize - (existingPos.totalCost || 0), 0)
        : config.maxPositionSize;

    if (remainingCap <= 0) {
        logger.warn(`No remaining capacity for: ${market || effectiveConditionId}. Skipping.`);
        return;
    }

    // We want each trade to be exactly MIN_TRADE_SIZE (e.g. $1) — never more,
    // never less. If we don't have that much remaining capacity, we skip.
    const tradeUnit = config.minTradeSize;
    if (remainingCap < tradeUnit) {
        logger.info(
            `Remaining capacity $${remainingCap.toFixed(2)} below trade unit $${tradeUnit} for ${market || effectiveConditionId}. Skipping further buys.`,
        );
        return;
    }

    // Check balance before deciding on the trade
    const balance = await getUsdcBalance();
    if (balance < tradeUnit) {
        logger.error(`Insufficient balance: $${balance.toFixed(2)} < trade unit $${tradeUnit.toFixed(2)} needed`);
        return;
    }

    const tradeSize = tradeUnit;

    logger.trade(`BUY ${market || tokenId} | Size: $${tradeSize.toFixed(2)} | Trader price: ${price}`);

    if (config.dryRun) {
        logger.trade(`[SIM] BUY ${market || tokenId} | $${tradeSize.toFixed(2)} @ $${price} | outcome: ${trade.outcome || '?'}`);
        const dryShares = tradeSize / price;
        if (existingPos) {
            const newShares = existingPos.shares + dryShares;
            const newTotalCost = existingPos.totalCost + tradeSize;
            updatePosition(effectiveConditionId, {
                shares: newShares,
                avgBuyPrice: newTotalCost / newShares,
                totalCost: newTotalCost,
            });
            logger.info(`[SIM] Position accumulated: $${newTotalCost.toFixed(2)} / $${config.maxPositionSize}`);
        } else {
            addPosition({
                conditionId: effectiveConditionId,
                tokenId,
                market: market || marketOpts.question || tokenId,
                shares: dryShares,
                avgBuyPrice: price,
                totalCost: tradeSize,
                outcome: trade.outcome,
            });
        }
        recordSimBuy();
        lastBuyTimestamp = Date.now();

        // Lock onto this topic after the first successful simulated buy
        if (!mainConditionId && effectiveConditionId) {
            mainConditionId = effectiveConditionId;
            logger.info(`Main topic locked to condition ${effectiveConditionId} (${market || marketOpts.question || tokenId})`);
        }

        return;
    }

    // Place market order with retries
    const client = getClient();
    let filled = false;
    let totalSharesFilled = 0;
    let totalCostFilled = 0;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
            const remainingAmount = tradeSize - totalCostFilled;
            if (remainingAmount < config.minTradeSize) break;

            logger.info(`Buy attempt ${attempt}/${config.maxRetries} | Amount: $${remainingAmount.toFixed(2)}`);

            // Use FAK (fill-and-kill) to get what's available, then retry remainder
            const response = await client.createAndPostMarketOrder(
                {
                    tokenID: tokenId,
                    side: Side.BUY,
                    amount: remainingAmount,
                    price: Math.min(price * 1.05, 0.99), // 5% slippage allowance, max 0.99
                },
                {
                    tickSize: marketOpts.tickSize,
                    negRisk: marketOpts.negRisk,
                },
                OrderType.FOK,
            );

            if (response && response.success) {
                logger.success(`Order placed: ${response.orderID} | Status: ${response.status}`);

                // Check if fully filled by trying to get trade info
                const takingAmount = parseFloat(response.takingAmount || '0');
                const makingAmount = parseFloat(response.makingAmount || '0');

                if (takingAmount > 0 || makingAmount > 0) {
                    totalSharesFilled += takingAmount || (remainingAmount / price);
                    totalCostFilled += makingAmount || remainingAmount;
                    filled = true;
                    break; // FOK either fills fully or cancels
                } else {
                    filled = true;
                    totalSharesFilled = tradeSize / price;
                    totalCostFilled = tradeSize;
                    break;
                }
            } else {
                logger.warn(`Order not filled. Error: ${response?.errorMsg || 'Unknown'}`);
            }
        } catch (err) {
            logger.error(`Buy attempt ${attempt} failed:`, err.message);
        }

        // Wait before retry
        if (attempt < config.maxRetries) {
            await new Promise((r) => setTimeout(r, config.retryDelay));
        }
    }

    if (!filled || totalCostFilled === 0) {
        logger.error(`Failed to fill buy order for ${market || tokenId} after ${config.maxRetries} attempts`);
        return;
    }

    // Calculate avg buy price for this fill
    const fillAvgPrice = totalSharesFilled > 0 ? totalCostFilled / totalSharesFilled : price;

    if (existingPos) {
        // Accumulate into existing position (weighted avg price)
        const newShares = existingPos.shares + totalSharesFilled;
        const newTotalCost = existingPos.totalCost + totalCostFilled;
        const newAvgBuyPrice = newTotalCost / newShares;
        updatePosition(effectiveConditionId, {
            shares: newShares,
            avgBuyPrice: newAvgBuyPrice,
            totalCost: newTotalCost,
        });
        logger.success(`Position updated: ${existingPos.market} | total $${newTotalCost.toFixed(2)} / $${config.maxPositionSize}`);
    } else {
        // New position
        addPosition({
            conditionId: effectiveConditionId,
            tokenId,
            market: market || marketOpts.question || tokenId,
            shares: totalSharesFilled,
            avgBuyPrice: fillAvgPrice,
            totalCost: totalCostFilled,
            outcome: trade.outcome,
        });

        // Auto-sell only on initial entry, not on accumulation
        if (config.autoSellEnabled) {
            await placeAutoSell(effectiveConditionId, tokenId, totalSharesFilled, fillAvgPrice, marketOpts);
        }
    }

    lastBuyTimestamp = Date.now();

    // Lock onto this topic after the first successful live buy
    if (!mainConditionId && effectiveConditionId) {
        mainConditionId = effectiveConditionId;
        logger.info(`Main topic locked to condition ${effectiveConditionId} (${market || marketOpts.question || tokenId})`);
    }
}

/**
 * Execute a SELL trade (copy trader's sell)
 * @param {Object} trade - Trade info from watcher
 */
export async function executeSell(trade) {
    const { tokenId, conditionId, market, price } = trade;

    // Get market options to resolve conditionId
    let effectiveConditionId = conditionId;
    let marketOpts;
    if (!effectiveConditionId) {
        marketOpts = await getMarketOptions(tokenId);
        effectiveConditionId = marketOpts.conditionId;
    }

    // If we've locked onto a main topic, ignore sells from all other markets.
    if (mainConditionId && effectiveConditionId && effectiveConditionId !== mainConditionId) {
        return;
    }

    // Check if we have a position
    const position = getPosition(effectiveConditionId);
    if (!position) {
        logger.warn(`No position found for: ${market || effectiveConditionId}. Skipping sell.`);
        return;
    }

    if (position.status === 'selling' || position.status === 'sold') {
        logger.warn(`Position already ${position.status}: ${market || effectiveConditionId}. Skipping.`);
        return;
    }

    logger.trade(`SELL ${position.market} | Shares: ${position.shares} | Trader price: ${price}`);

    if (config.dryRun) {
        logger.info('[DRY RUN] Would place sell order');
        removePosition(effectiveConditionId);
        return;
    }

    // Cancel existing auto-sell order if any
    if (position.sellOrderId) {
        try {
            const client = getClient();
            await client.cancelOrder(position.sellOrderId);
            logger.info(`Cancelled auto-sell order: ${position.sellOrderId}`);
        } catch (err) {
            logger.warn(`Failed to cancel auto-sell: ${err.message}`);
        }
    }

    updatePosition(effectiveConditionId, { status: 'selling' });

    if (!marketOpts) {
        marketOpts = await getMarketOptions(tokenId);
    }

    const client = getClient();
    let filled = false;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
            if (config.sellMode === 'market') {
                // Market sell (FOK)
                logger.info(`Sell attempt ${attempt}/${config.maxRetries} (market) | Shares: ${position.shares}`);

                const response = await client.createAndPostMarketOrder(
                    {
                        tokenID: tokenId,
                        side: Side.SELL,
                        amount: position.shares,
                        price: Math.max(price * 0.95, 0.01), // 5% slippage, min 0.01
                    },
                    {
                        tickSize: marketOpts.tickSize,
                        negRisk: marketOpts.negRisk,
                    },
                    OrderType.FOK,
                );

                if (response && response.success) {
                    logger.success(`Sell order placed: ${response.orderID}`);
                    filled = true;
                    break;
                } else {
                    logger.warn(`Sell not filled: ${response?.errorMsg || 'Unknown'}`);
                }
            } else {
                // Limit sell at trader's sell price
                logger.info(`Sell attempt ${attempt}/${config.maxRetries} (limit) | Price: ${price}`);

                const response = await client.createAndPostOrder(
                    {
                        tokenID: tokenId,
                        price: price,
                        size: position.shares,
                        side: Side.SELL,
                    },
                    {
                        tickSize: marketOpts.tickSize,
                        negRisk: marketOpts.negRisk,
                    },
                    OrderType.GTC,
                );

                if (response && response.success) {
                    logger.success(`Limit sell placed: ${response.orderID} @ $${price}`);
                    filled = true;
                    break;
                } else {
                    logger.warn(`Limit sell failed: ${response?.errorMsg || 'Unknown'}`);
                }
            }
        } catch (err) {
            logger.error(`Sell attempt ${attempt} failed:`, err.message);
        }

        if (attempt < config.maxRetries) {
            await new Promise((r) => setTimeout(r, config.retryDelay));
        }
    }

    if (filled) {
        removePosition(effectiveConditionId);
        logger.money(`Position sold: ${position.market}`);
    } else {
        updatePosition(effectiveConditionId, { status: 'open' });
        logger.error(`Failed to sell ${position.market} after ${config.maxRetries} attempts`);
    }
}
