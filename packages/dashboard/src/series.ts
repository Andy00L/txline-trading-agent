/**
 * Pure derivations of the dashboard's time-series from a single AgentSnapshot. Kept out of
 * React (no hooks, no DOM) so the chart math is unit-testable and deterministic, mirroring the
 * core-purity rule the runtime packages follow. Money stays integer micro-USD (bigint); only
 * the chart components convert to Number for pixel geometry, never for displayed money.
 */

import type { AgentSnapshot, PositionView, SettleView } from './api';

export type EquityPoint = {
  readonly settleIndex: number; // 1-based order of settlement
  readonly atMs: number;
  readonly fixtureId: number;
  readonly pnlMicroUsd: bigint;
  readonly bankrollMicroUsd: bigint; // running bankroll after this settlement
  readonly won: boolean;
};

export type EquitySeries = {
  readonly startMicroUsd: bigint;
  readonly points: readonly EquityPoint[];
  readonly minMicroUsd: bigint; // y-axis floor (includes the start baseline)
  readonly maxMicroUsd: bigint; // y-axis ceiling
};

export type ClvPoint = {
  readonly settleIndex: number;
  readonly fixtureId: number;
  readonly clvProb: number;
  readonly won: boolean;
};

export type ClvSummary = {
  readonly count: number;
  readonly meanClvProb: number;
  readonly positiveCount: number;
  readonly positiveRate: number; // [0, 1]
  readonly maxAbsClvProb: number; // for symmetric y-scaling around zero
};

const toBigIntOr = (value: string, fallback: bigint): bigint => {
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
};

type SettledEntry = { readonly position: PositionView; readonly settlement: SettleView };

/** Settled positions in settlement order (by settle time, then commit index as a stable tie-break). */
const settledInOrder = (positions: readonly PositionView[]): readonly SettledEntry[] =>
  positions
    .map((position): SettledEntry | null =>
      position.settlement === null ? null : { position, settlement: position.settlement },
    )
    .filter((entry): entry is SettledEntry => entry !== null)
    .sort(
      (left, right) =>
        left.settlement.settledAtMs - right.settlement.settledAtMs ||
        left.position.index - right.position.index,
    );

/** Running bankroll after each settlement, reconstructed from the starting bankroll and each
 * settled PnL. The point estimate the equity line draws is exact (bigint); min/max bound the
 * y-axis and always include the starting baseline so a flat or all-losing run still renders. */
export const buildEquitySeries = (snapshot: AgentSnapshot): EquitySeries => {
  const startMicroUsd = toBigIntOr(snapshot.startingBankrollMicroUsd, 0n);
  let running = startMicroUsd;
  let minMicroUsd = startMicroUsd;
  let maxMicroUsd = startMicroUsd;
  const points = settledInOrder(snapshot.positions).map((entry, orderIndex): EquityPoint => {
    const pnlMicroUsd = toBigIntOr(entry.settlement.pnlMicroUsd, 0n);
    running += pnlMicroUsd;
    if (running < minMicroUsd) {
      minMicroUsd = running;
    }
    if (running > maxMicroUsd) {
      maxMicroUsd = running;
    }
    return {
      settleIndex: orderIndex + 1,
      atMs: entry.settlement.settledAtMs,
      fixtureId: entry.position.fixtureId,
      pnlMicroUsd,
      bankrollMicroUsd: running,
      won: entry.settlement.won,
    };
  });
  return { startMicroUsd, points, minMicroUsd, maxMicroUsd };
};

/** Per-bet closing-line value in settlement order, the edge proxy a desk tracks. */
export const buildClvSeries = (snapshot: AgentSnapshot): readonly ClvPoint[] =>
  settledInOrder(snapshot.positions).map((entry, orderIndex) => ({
    settleIndex: orderIndex + 1,
    fixtureId: entry.position.fixtureId,
    clvProb: entry.settlement.clvProb,
    won: entry.settlement.won,
  }));

/** Mean CLV and the share of bets that beat the close, computed over the live settled bets
 * (not the backtest sweep). Reported as-is, including when it is small or negative. */
export const summarizeClv = (points: readonly ClvPoint[]): ClvSummary => {
  if (points.length === 0) {
    return { count: 0, meanClvProb: 0, positiveCount: 0, positiveRate: 0, maxAbsClvProb: 0 };
  }
  const total = points.reduce((sum, point) => sum + point.clvProb, 0);
  const positiveCount = points.filter((point) => point.clvProb > 0).length;
  const maxAbsClvProb = points.reduce((peak, point) => Math.max(peak, Math.abs(point.clvProb)), 0);
  return {
    count: points.length,
    meanClvProb: total / points.length,
    positiveCount,
    positiveRate: positiveCount / points.length,
    maxAbsClvProb,
  };
};
