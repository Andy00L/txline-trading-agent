import { describe, expect, it } from 'vitest';
import type { Clock } from '@txline-agent/core';
import { AgentStateStore, type CommitView, type SettleView } from './state-store.js';

class FixedClock implements Clock {
  private ms = 1_000;

  nowMs(): number {
    return this.ms;
  }

  advance(byMs: number): void {
    this.ms += byMs;
  }
}

const commitView = (index: number): CommitView => ({
  index,
  onChainIndex: String(index),
  fixtureId: 100 + index,
  marketKey: `100${index}:1X2:FT:`,
  outcome: 'home',
  signalKind: 'steam',
  stakeMicroUsd: '25000000',
  entryOddsMilli: 2100,
  fairProb: 0.5,
  committedAtMs: 1_000,
  txSig: `commit-${index}`,
  explorerUrl: `https://explorer/${index}`,
});

const settleView = (index: number, won: boolean, pnlMicroUsd: string): SettleView => ({
  index,
  fixtureId: 100 + index,
  outcome: 'home',
  result: won ? 'home' : 'away',
  won,
  pnlMicroUsd,
  settledSeq: 400 + index,
  settledAtMs: 2_000,
  closingFairProb: 0.52,
  clvProb: 0.02,
  txSig: `settle-${index}`,
  explorerUrl: `https://explorer/settle/${index}`,
});

describe('AgentStateStore', () => {
  it('projects commits, settlements, and the running bankroll', () => {
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 1_000_000_000n });
    store.recordCommit(commitView(0));
    store.recordCommit(commitView(1));
    store.markSettled(0, settleView(0, true, '26000000'));
    store.markSettled(1, settleView(1, false, '-25000000'));

    const snapshot = store.snapshot();
    expect(snapshot.commitsCount).toBe(2);
    expect(snapshot.settlesCount).toBe(2);
    expect(snapshot.positions).toHaveLength(2);
    expect(snapshot.positions[0]?.status).toBe('settled');
    expect(snapshot.positions[0]?.settlement?.won).toBe(true);
    // 1_000_000_000 + 26_000_000 - 25_000_000 net.
    expect(snapshot.realizedPnlMicroUsd).toBe('1000000');
    expect(snapshot.bankrollMicroUsd).toBe('1001000000');
  });

  it('counts events and stamps feed status with the injected clock', () => {
    const clock = new FixedClock();
    const store = new AgentStateStore({ clock, startingBankroll: 0n });
    store.recordEvent();
    clock.advance(500);
    store.recordEvent();
    store.recordFeedStatus('connected', 'initial connection');

    const snapshot = store.snapshot();
    expect(snapshot.eventsProcessed).toBe(2);
    expect(snapshot.lastEventAtMs).toBe(1_500);
    expect(snapshot.feedStatus?.kind).toBe('connected');
    expect(snapshot.feedStatus?.detail).toBe('initial connection');
  });

  it('bounds nothing below the cap and notifies subscribers until they unsubscribe', () => {
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 0n });
    const seenErrorCounts: number[] = [];
    const unsubscribe = store.subscribe((snapshot) => seenErrorCounts.push(snapshot.errorsCount));
    store.recordError('commit', 'first failure');
    store.recordError('settle', 'second failure');
    unsubscribe();
    store.recordError('commit', 'after unsubscribe');

    const snapshot = store.snapshot();
    expect(snapshot.errorsCount).toBe(3);
    expect(snapshot.recentErrors).toHaveLength(3);
    expect(snapshot.recentErrors[0]?.stage).toBe('commit');
    // The subscriber saw the first two snapshots, not the post-unsubscribe one.
    expect(seenErrorCounts).toEqual([1, 2]);
  });
});
