import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import config from '../config/index.js';
import { getPolygonProvider, getUsdcBalance } from './client.js';
import { getOpenPositions, removePosition } from './position.js';
import { recordSimResult } from '../utils/simStats.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const POSITION_LOG_FILE = path.join(DATA_DIR, 'position_log.txt');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Contract addresses on Polygon
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_CTF_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// CTF ABI (minimal for redeemPositions & balanceOf)
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function balanceOf(address owner, uint256 tokenId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
];

/**
 * Check if a market has been resolved via Gamma API
 */
async function checkMarketResolution(conditionId) {
    try {
        const url = `${config.gammaHost}/markets?condition_id=${conditionId}`;
        const response = await fetch(url);
        if (!response.ok) return null;

        const markets = await response.json();
        if (!markets || markets.length === 0) return null;

        const market = markets[0];
        return {
            resolved: market.closed || market.resolved || false,
            active: market.active,
            question: market.question,
        };
    } catch (err) {
        logger.error('Failed to check market resolution:', err.message);
        return null;
    }
}

/**
 * Check on-chain payout fractions for a condition
 * Returns: { resolved: bool, payouts: [yes_fraction, no_fraction] }
 */
async function checkOnChainPayout(conditionId) {
    try {
        const provider = await getPolygonProvider();
        const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);

        const denominator = await ctf.payoutDenominator(conditionId);
        if (denominator.isZero()) return { resolved: false, payouts: [] };

        const payouts = [];
        for (let i = 0; i < 2; i++) {
            const numerator = await ctf.payoutNumerators(conditionId, i);
            payouts.push(numerator.toNumber() / denominator.toNumber());
        }

        return { resolved: true, payouts };
    } catch {
        return { resolved: false, payouts: [] };
    }
}

/**
 * Redeem winning position on-chain (real mode only)
 */
async function redeemPosition(conditionId, isNegRisk = false) {
    try {
        const provider = await getPolygonProvider();
        const wallet = new ethers.Wallet(config.privateKey, provider);
        const ctfAddress = isNegRisk ? NEG_RISK_CTF_ADDRESS : CTF_ADDRESS;
        const ctf = new ethers.Contract(ctfAddress, CTF_ABI, wallet);

        const parentCollectionId = ethers.constants.HashZero;
        const indexSets = [1, 2];

        logger.info(`Redeeming position: ${conditionId}`);
        const tx = await ctf.redeemPositions(
            USDC_ADDRESS,
            parentCollectionId,
            conditionId,
            indexSets,
            { gasLimit: 300000 },
        );

        logger.info(`Redeem tx: ${tx.hash}`);
        const receipt = await tx.wait();
        logger.success(`Redeemed in block ${receipt.blockNumber}`);
        return true;
    } catch (err) {
        logger.error('Failed to redeem:', err.message);
        return false;
    }
}

/**
 * Append a human-readable snapshot of current balance, open positions, and
 * the most recent resolution (win/loss + PnL) to a text log file.
 */
async function appendPositionLog({ position, result, pnl, returned }) {
    try {
        const balance = await getUsdcBalance();
        const openPositions = getOpenPositions();
        const ts = new Date().toISOString();

        const lines = [];
        lines.push(`=== Snapshot ${ts} ===`);
        lines.push(`Balance: $${balance.toFixed(2)}`);
        lines.push('');
        lines.push('Open positions:');

        if (openPositions.length === 0) {
            lines.push('  (none)');
        } else {
            for (const p of openPositions) {
                lines.push(
                    `  - ${p.market} | ${p.outcome || '?'} | ` +
                    `${p.shares.toFixed(3)} sh @ $${p.avgBuyPrice.toFixed(3)} | cost $${p.totalCost.toFixed(2)}`,
                );
            }
        }

        lines.push('');
        lines.push('Last resolution:');
        const sign = pnl >= 0 ? '+' : '';
        lines.push(`  Market : ${position.market}`);
        lines.push(`  Outcome: ${position.outcome}`);
        lines.push(`  Result : ${result}`);
        lines.push(`  Returned: $${returned.toFixed(2)}`);
        lines.push(`  PnL    : ${sign}$${pnl.toFixed(2)}`);
        lines.push('');

        fs.appendFileSync(POSITION_LOG_FILE, `${lines.join('\n')}\n`, 'utf-8');
    } catch (err) {
        logger.error('Failed to write position log:', err.message);
    }
}

/**
 * Simulate redemption: determine win/loss and record stats + text log
 */
async function simulateRedeem(position) {
    // Need on-chain payout to know who actually won
    const onChain = await checkOnChainPayout(position.conditionId);

    if (!onChain.resolved) {
        logger.info(`[SIM] Market resolved via API but payout not on-chain yet: ${position.market}`);
        return false; // check again next interval
    }

    // outcome index: YES = 0, NO = 1
    const outcomeStr = (position.outcome || 'yes').toLowerCase();
    const outcomeIdx = outcomeStr === 'yes' ? 0 : 1;
    const payoutFraction = onChain.payouts[outcomeIdx] ?? 0;

    // In Polymarket, winning shares redeem at $1 each
    const returned = payoutFraction * position.shares;
    const pnl = returned - position.totalCost;

    if (payoutFraction > 0) {
        logger.money(
            `[SIM] WIN! "${position.market}" | ${position.outcome} won` +
            ` | +$${pnl.toFixed(2)} (+${((pnl / position.totalCost) * 100).toFixed(1)}%)`,
        );
        recordSimResult(position, 'WIN', pnl, returned);
    } else {
        logger.error(
            `[SIM] LOSS: "${position.market}" | ${position.outcome} lost` +
            ` | -$${position.totalCost.toFixed(2)} (-100%)`,
        );
        recordSimResult(position, 'LOSS', pnl, returned);
    }

    // Write a snapshot of current balance, open positions, and this resolution
    await appendPositionLog({
        position,
        result: payoutFraction > 0 ? 'WIN' : 'LOSS',
        pnl,
        returned,
    });

    removePosition(position.conditionId);
    return true;
}

/**
 * Check all open positions for resolved markets and redeem/simulate
 */
export async function checkAndRedeemPositions() {
    const positions = getOpenPositions();
    if (positions.length === 0) return;

    logger.info(`Checking ${positions.length} position(s) for resolution...`);

    for (const position of positions) {
        try {
            // 1. Check via Gamma API
            const resolution = await checkMarketResolution(position.conditionId);
            const isResolved = resolution?.resolved;

            if (!isResolved) {
                // 2. Fallback: on-chain check
                const onChain = await checkOnChainPayout(position.conditionId);
                if (!onChain.resolved) continue;
                logger.info(`Market resolved on-chain: ${position.market}`);
            } else {
                logger.info(`Market resolved: ${position.market}`);
            }

            // 3. Simulate or execute real redeem
            if (config.dryRun) {
                await simulateRedeem(position);
            } else {
                const success = await redeemPosition(position.conditionId);
                if (success) {
                    removePosition(position.conditionId);
                    logger.money(`Redeemed: ${position.market}`);
                }
            }
        } catch (err) {
            logger.error(`Error checking ${position.market}:`, err.message);
        }
    }
}
