import { ODDS_MILLI_SCALE, type DecimalOddsMilli, type MicroUsd } from '../units.js';

/**
 * Signed realized PnL in micro-USD for a settled bet. A win returns the profit
 * stake * (odds - 1); a loss returns -stake. Integer arithmetic only; this mirrors
 * the on-chain settle formula. sourceRef: docs/BUILD_PLAN.md (settle_decision PnL).
 */
export const computePnl = (
  won: boolean,
  stake: MicroUsd,
  entryOddsMilli: DecimalOddsMilli,
): bigint =>
  won
    ? (stake * BigInt(entryOddsMilli - ODDS_MILLI_SCALE)) / BigInt(ODDS_MILLI_SCALE)
    : -stake;
