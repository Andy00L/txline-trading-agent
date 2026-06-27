import { describe, expect, it } from 'vitest';
import {
  decimalOddsMilli,
  err,
  marketKey,
  microUsdSaturating,
  ok,
  prob,
  type Clock,
  type CommittedPosition,
  type Decision,
  type DecimalOddsMilli,
  type MarketKey,
  type Outcome,
  type Prob,
  type Result,
  type SettledPosition,
} from '@txline-agent/core';
import type {
  CommitReceipt,
  CommitRequest,
  OnChainError,
  SettleReceipt,
  SettleRequest,
  StrategyAccount,
} from '@txline-agent/onchain-client';
import type { ScoresStatValidation, TxlineError } from '@txline-agent/txline';
import { AgentStateStore } from './state-store.js';
import {
  OnChainSink,
  type CommitSettlePort,
  type ScoresProofSource,
} from './onchain-sink.js';

const FIXTURE_ID = 17588302;
const MKEY: MarketKey = marketKey({
  fixtureId: FIXTURE_ID,
  superOddsType: '1X2_PARTICIPANT_RESULT',
  marketPeriod: 'FT',
  marketParameters: '',
});

class FixedClock implements Clock {
  nowMs(): number {
    return 1_000;
  }
}

const oddsMilli = (value: number): DecimalOddsMilli => {
  const result = decimalOddsMilli(value);
  if (!result.ok) {
    throw new Error(`bad odds ${value}`);
  }
  return result.value;
};

const probOf = (value: number): Prob => {
  const result = prob(value);
  if (!result.ok) {
    throw new Error(`bad prob ${value}`);
  }
  return result.value;
};

const decision: Decision = {
  fixtureId: FIXTURE_ID,
  marketKey: MKEY,
  outcome: 'home',
  tsMs: 1_000,
  signalKind: 'steam',
  fairProb: probOf(0.5),
  entryOddsMilli: oddsMilli(2100),
  stake: microUsdSaturating(25_000_000n),
  edge: 0.02,
};

const committedPosition: CommittedPosition = { index: 0, decision, committedAtMs: 1_000 };

const settledPosition = (result: Outcome): SettledPosition => ({
  index: 0,
  decision,
  result,
  won: result === 'home',
  pnl: 26_000_000n,
  settledAtMs: 2_000,
  settledSeq: 412,
  closingFairProb: probOf(0.52),
  closingFairProbKnown: true,
});

const makeStrategy = (decisionsCount: bigint): StrategyAccount => ({
  authority: new Uint8Array(32),
  strategyId: 0n,
  txlineProgram: new Uint8Array(32),
  startingBankroll: 1_000_000_000n,
  bankroll: 1_000_000_000n,
  realizedPnl: 0n,
  decisionsCount,
  openCount: 0n,
  settledCount: 0n,
  wins: 0,
  losses: 0,
  pushes: 0,
  commitLogRoot: new Uint8Array(32),
  bump: 255,
});

const ROOT_32 = Array.from({ length: 32 }, (_unused, index) => index);

// A two-stat (participant 1 vs participant 2) proof with empty Merkle branches, enough for
// buildSettleArgs to succeed against a fake port.
const makeValidation = (participant1Goals: number, participant2Goals: number): ScoresStatValidation => ({
  ts: 1_700_000_000_000,
  statToProve: { key: 1, value: participant1Goals, period: 0 },
  eventStatRoot: ROOT_32,
  summary: {
    fixtureId: FIXTURE_ID,
    updateStats: { updateCount: 1, minTimestamp: 1_700_000_000_000, maxTimestamp: 1_700_000_000_000 },
    eventStatsSubTreeRoot: ROOT_32,
  },
  statProof: [],
  subTreeProof: [],
  mainTreeProof: [],
  statToProve2: { key: 2, value: participant2Goals, period: 0 },
  statProof2: [],
});

type ProofRequest = {
  readonly fixtureId: number;
  readonly seq: number;
  readonly statKey: number;
  readonly statKey2?: number;
};

class FakePort implements CommitSettlePort {
  decisionsCount = 7n;
  commitError: OnChainError | null = null;
  readonly commits: CommitRequest[] = [];
  readonly settles: SettleRequest[] = [];

  async readStrategy(): Promise<Result<StrategyAccount | null, OnChainError>> {
    return ok(makeStrategy(this.decisionsCount));
  }

  async commit(request: CommitRequest): Promise<Result<CommitReceipt, OnChainError>> {
    if (this.commitError) {
      return err(this.commitError);
    }
    this.commits.push(request);
    const index = this.decisionsCount;
    this.decisionsCount += 1n;
    return ok({ positionId: `pda-${index}`, txSig: `commit-sig-${index}`, index });
  }

  async settle(request: SettleRequest): Promise<Result<SettleReceipt, OnChainError>> {
    this.settles.push(request);
    return ok({ txSig: `settle-sig-${request.index}`, won: true, pnl: 26_000_000n });
  }
}

class FakeProofs implements ScoresProofSource {
  validation: ScoresStatValidation = makeValidation(2, 1);
  error: TxlineError | null = null;
  readonly requests: ProofRequest[] = [];

  async getScoresStatValidation(params: ProofRequest): Promise<Result<ScoresStatValidation, TxlineError>> {
    this.requests.push(params);
    if (this.error) {
      return err(this.error);
    }
    return ok(this.validation);
  }
}

const buildSink = (
  port: CommitSettlePort,
  proofs: ScoresProofSource,
  store: AgentStateStore,
): OnChainSink =>
  new OnChainSink({
    port,
    proofs,
    store,
    strategyBytes: new Uint8Array(32).fill(3),
    nextNonce: () => new Uint8Array(32).fill(9),
    log: () => {},
  });

describe('OnChainSink', () => {
  it('commits at the on-chain index and settles with a proof fetched for the settled seq', async () => {
    const port = new FakePort();
    const proofs = new FakeProofs();
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 1_000_000_000n });
    const sink = buildSink(port, proofs, store);

    await sink.onCommit(committedPosition);
    expect(port.commits).toHaveLength(1);
    // The sealed reveal uses the on-chain decisions_count (7), not the local index (0).
    expect(port.commits[0]?.reveal.index).toBe(7n);
    expect(port.commits[0]?.fixtureId).toBe(BigInt(FIXTURE_ID));
    const afterCommit = store.snapshot();
    expect(afterCommit.commitsCount).toBe(1);
    expect(afterCommit.positions[0]?.onChainIndex).toBe('7');
    expect(afterCommit.positions[0]?.status).toBe('committed');

    await sink.onSettle(settledPosition('home'));
    expect(proofs.requests[0]).toEqual({
      fixtureId: FIXTURE_ID,
      seq: 412,
      statKey: 1,
      statKey2: 2,
    });
    // The settle targets the same on-chain index captured at commit time.
    expect(port.settles[0]?.index).toBe(7n);
    const settled = store.snapshot();
    expect(settled.settlesCount).toBe(1);
    expect(settled.positions[0]?.status).toBe('settled');
    expect(settled.positions[0]?.settlement?.won).toBe(true);
    expect(settled.bankrollMicroUsd).toBe('1026000000');
  });

  it('derives the claimed result in participant space from the proven goals', async () => {
    const port = new FakePort();
    const proofs = new FakeProofs();
    proofs.validation = makeValidation(0, 2); // participant 1: 0, participant 2: 2 -> away wins (side 2)
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 0n });
    const sink = buildSink(port, proofs, store);

    await sink.onCommit(committedPosition);
    await sink.onSettle(settledPosition('away'));

    expect(port.settles[0]?.settleArgs.claimedResult).toBe(2);
  });

  it('records an error and does not settle when there is no committed reveal', async () => {
    const port = new FakePort();
    const proofs = new FakeProofs();
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 0n });
    const sink = buildSink(port, proofs, store);

    await sink.onSettle(settledPosition('home'));

    expect(port.settles).toHaveLength(0);
    expect(proofs.requests).toHaveLength(0);
    const snapshot = store.snapshot();
    expect(snapshot.settlesCount).toBe(0);
    expect(snapshot.errorsCount).toBe(1);
  });

  it('records a commit failure without storing a reveal', async () => {
    const port = new FakePort();
    port.commitError = { kind: 'rpc', detail: 'node unreachable' };
    const proofs = new FakeProofs();
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 0n });
    const sink = buildSink(port, proofs, store);

    await sink.onCommit(committedPosition);

    const snapshot = store.snapshot();
    expect(snapshot.commitsCount).toBe(0);
    expect(snapshot.errorsCount).toBe(1);
  });

  it('records a settle error when the proof fetch fails, leaving the position committed', async () => {
    const port = new FakePort();
    const proofs = new FakeProofs();
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 0n });
    const sink = buildSink(port, proofs, store);

    await sink.onCommit(committedPosition);
    proofs.error = { kind: 'server-error', status: 503, detail: 'roots not posted yet' };
    await sink.onSettle(settledPosition('home'));

    expect(port.settles).toHaveLength(0);
    const snapshot = store.snapshot();
    expect(snapshot.settlesCount).toBe(0);
    expect(snapshot.errorsCount).toBe(1);
    expect(snapshot.positions[0]?.status).toBe('committed');
  });
});
