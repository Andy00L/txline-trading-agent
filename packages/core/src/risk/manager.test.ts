import { describe, expect, it } from 'vitest';
import { marketKey, type MarketKey } from '../domain/market.js';
import { decimalOddsMilli, prob, usdToMicroUsd, type DecimalOddsMilli, type MicroUsd, type Prob } from '../units.js';
import { createRiskState, evaluate, onAnomaly, onCommit, onSettlement, reset } from './manager.js';
import type { EvaluateInput, RiskConfig } from './types.js';

const oddsOf = (milli: number): DecimalOddsMilli => {
  const odds = decimalOddsMilli(milli);
  if (!odds.ok) {
    throw new Error(`bad odds ${milli}`);
  }
  return odds.value;
};

const probOf = (value: number): Prob => {
  const result = prob(value);
  if (!result.ok) {
    throw new Error(`bad prob ${value}`);
  }
  return result.value;
};

const micro = (usd: number): MicroUsd => {
  const result = usdToMicroUsd(usd);
  if (!result.ok) {
    throw new Error(`bad usd ${usd}`);
  }
  return result.value;
};

const MARKET: MarketKey = marketKey({
  fixtureId: 1,
  superOddsType: 'StablePrice',
  marketPeriod: 'FT',
  marketParameters: '',
});

const config: RiskConfig = {
  bankrollFloor: micro(10),
  maxStakePerOrder: micro(50),
  maxConcurrent: 3,
  totalExposureCap: micro(200),
  perFixtureExposureCap: micro(100),
  perMarketExposureCap: micro(80),
  staleFeedMs: 5000,
  outlierOddsZ: 3,
  maxDailyDrawdown: micro(100),
};

const baseInput = (overrides: Partial<EvaluateInput>): EvaluateInput => ({
  proposedStake: micro(20),
  offeredOddsMilli: oddsOf(2000),
  fixtureId: 1,
  marketKey: MARKET,
  nowMs: 10_000,
  feedTsMs: 10_000,
  context: { consensusFairProb: probOf(0.5), dispersion: 0 },
  ...overrides,
});

const freshState = () => createRiskState(micro(1000));

describe('evaluate', () => {
  it('allows an order within all caps at the proposed stake', () => {
    const verdict = evaluate(freshState(), baseInput({}), config);
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.stake).toBe(micro(20));
    }
  });

  it('blocks below the bankroll floor', () => {
    const state = { ...freshState(), bankroll: micro(5) };
    expect(evaluate(state, baseInput({}), config)).toEqual({ allowed: false, reason: 'bankroll-floor' });
  });

  it('blocks on daily drawdown', () => {
    const state = { ...freshState(), bankroll: micro(800) };
    expect(evaluate(state, baseInput({}), config)).toEqual({ allowed: false, reason: 'daily-drawdown' });
  });

  it('blocks a stale feed', () => {
    expect(evaluate(freshState(), baseInput({ feedTsMs: 0, nowMs: 10_000 }), config)).toEqual({
      allowed: false,
      reason: 'stale-feed',
    });
  });

  it('blocks outlier odds when dispersion is known', () => {
    const verdict = evaluate(
      freshState(),
      baseInput({
        offeredOddsMilli: oddsOf(5000),
        context: { consensusFairProb: probOf(0.5), dispersion: 0.02 },
      }),
      config,
    );
    expect(verdict).toEqual({ allowed: false, reason: 'outlier-odds' });
  });

  it('skips the outlier check when dispersion is 0 (consensus only)', () => {
    const verdict = evaluate(
      freshState(),
      baseInput({
        offeredOddsMilli: oddsOf(5000),
        context: { consensusFairProb: probOf(0.5), dispersion: 0 },
      }),
      config,
    );
    expect(verdict.allowed).toBe(true);
  });

  it('blocks at the concurrency limit', () => {
    const state = { ...freshState(), openCount: 3 };
    expect(evaluate(state, baseInput({}), config)).toEqual({ allowed: false, reason: 'max-concurrent' });
  });

  it('reduces the stake to the per-order maximum', () => {
    const verdict = evaluate(freshState(), baseInput({ proposedStake: micro(70) }), config);
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.stake).toBe(micro(50));
    }
  });

  it('reduces the stake to fit the per-market cap', () => {
    const state = onCommit(freshState(), { stake: micro(70), fixtureId: 1, marketKey: MARKET });
    const verdict = evaluate(state, baseInput({ proposedStake: micro(20) }), config);
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.stake).toBe(micro(10));
    }
  });

  it('blocks when a cap leaves no room', () => {
    const state = onCommit(freshState(), { stake: micro(80), fixtureId: 1, marketKey: MARKET });
    expect(evaluate(state, baseInput({ proposedStake: micro(20) }), config)).toEqual({
      allowed: false,
      reason: 'exposure-cap',
    });
  });

  it('latches an anomaly and clears it on reset', () => {
    const tripped = onAnomaly(freshState(), 'root-mismatch');
    expect(evaluate(tripped, baseInput({}), config)).toEqual({ allowed: false, reason: 'root-mismatch' });
    const recovered = reset(tripped);
    expect(evaluate(recovered, baseInput({}), config).allowed).toBe(true);
  });
});

describe('state transitions', () => {
  it('reserves exposure on commit and releases it with PnL on settlement', () => {
    const committed = onCommit(freshState(), { stake: micro(20), fixtureId: 1, marketKey: MARKET });
    expect(committed.totalExposure).toBe(micro(20));
    expect(committed.openCount).toBe(1);

    const settled = onSettlement(committed, {
      stake: micro(20),
      pnl: 20_000_000n,
      fixtureId: 1,
      marketKey: MARKET,
    });
    expect(settled.bankroll).toBe(micro(1020));
    expect(settled.totalExposure).toBe(micro(0));
    expect(settled.openCount).toBe(0);
  });
});
