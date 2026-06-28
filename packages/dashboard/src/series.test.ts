import { describe, expect, it } from 'vitest';
import type { AgentSnapshot, PositionView } from './api';
import { buildClvSeries, buildEquitySeries, summarizeClv } from './series';

const committed = (index: number): PositionView => ({
  index,
  onChainIndex: String(index),
  commitHash: 'ab'.repeat(32),
  fixtureId: 17_588_000 + index,
  marketKey: `m-${index}`,
  outcome: 'home',
  signalKind: 'cross-market',
  stakeMicroUsd: '25000000',
  entryOddsMilli: 2100,
  fairProb: 0.5,
  committedAtMs: 1_000 + index,
  txSig: `commit-${index}`,
  explorerUrl: `https://explorer/commit/${index}`,
  status: 'committed',
  settlement: null,
});

const settled = (
  index: number,
  settledAtMs: number,
  pnlMicroUsd: string,
  clvProb: number,
  won: boolean,
): PositionView => ({
  ...committed(index),
  status: 'settled',
  settlement: {
    index,
    fixtureId: 17_588_000 + index,
    outcome: 'home',
    result: won ? 'home' : 'away',
    won,
    pnlMicroUsd,
    settledSeq: 400 + index,
    settledAtMs,
    closingFairProb: 0.52,
    clvProb,
    txSig: `settle-${index}`,
    explorerUrl: `https://explorer/settle/${index}`,
  },
});

const snapshotOf = (positions: readonly PositionView[], startingBankrollMicroUsd: string): AgentSnapshot => ({
  startedAtMs: 0,
  eventsProcessed: 0,
  commitsCount: positions.length,
  settlesCount: positions.filter((position) => position.settlement !== null).length,
  errorsCount: 0,
  lastEventAtMs: null,
  feedStatus: null,
  startingBankrollMicroUsd,
  realizedPnlMicroUsd: '0',
  bankrollMicroUsd: startingBankrollMicroUsd,
  positions,
  recentErrors: [],
});

describe('buildEquitySeries', () => {
  it('reconstructs the running bankroll after each settlement, in settle-time order', () => {
    // Committed-only positions are ignored; settled ones drive the curve.
    const snapshot = snapshotOf(
      [committed(2), settled(0, 5_000, '26000000', 0.02, true), settled(1, 9_000, '-25000000', -0.01, false)],
      '1000000000',
    );
    const series = buildEquitySeries(snapshot);
    expect(series.startMicroUsd).toBe(1_000_000_000n);
    expect(series.points).toHaveLength(2);
    expect(series.points[0]?.settleIndex).toBe(1);
    expect(series.points[0]?.bankrollMicroUsd).toBe(1_026_000_000n);
    expect(series.points[1]?.bankrollMicroUsd).toBe(1_001_000_000n);
    // The start baseline bounds the floor; the peak is after the winning bet.
    expect(series.minMicroUsd).toBe(1_000_000_000n);
    expect(series.maxMicroUsd).toBe(1_026_000_000n);
  });

  it('orders by settle time, not array order', () => {
    const snapshot = snapshotOf(
      [settled(0, 9_000, '10000000', 0.01, true), settled(1, 5_000, '-5000000', -0.01, false)],
      '0',
    );
    const series = buildEquitySeries(snapshot);
    // The earlier settle (index 1, atMs 5000) comes first.
    expect(series.points[0]?.fixtureId).toBe(17_588_001);
    expect(series.points[0]?.bankrollMicroUsd).toBe(-5_000_000n);
    expect(series.points[1]?.bankrollMicroUsd).toBe(5_000_000n);
  });

  it('returns no points for a snapshot with no settlements', () => {
    const series = buildEquitySeries(snapshotOf([committed(0)], '1000000000'));
    expect(series.points).toHaveLength(0);
    expect(series.minMicroUsd).toBe(1_000_000_000n);
    expect(series.maxMicroUsd).toBe(1_000_000_000n);
  });
});

describe('buildClvSeries and summarizeClv', () => {
  it('summarizes mean CLV and the share of bets that beat the close', () => {
    const points = buildClvSeries(
      snapshotOf([settled(0, 5_000, '1', 0.02, true), settled(1, 9_000, '1', -0.01, false)], '0'),
    );
    const summary = summarizeClv(points);
    expect(summary.count).toBe(2);
    expect(summary.meanClvProb).toBeCloseTo(0.005, 10);
    expect(summary.positiveCount).toBe(1);
    expect(summary.positiveRate).toBe(0.5);
    expect(summary.maxAbsClvProb).toBe(0.02);
  });

  it('reports zeros for an empty series', () => {
    const summary = summarizeClv([]);
    expect(summary).toEqual({ count: 0, meanClvProb: 0, positiveCount: 0, positiveRate: 0, maxAbsClvProb: 0 });
  });
});
