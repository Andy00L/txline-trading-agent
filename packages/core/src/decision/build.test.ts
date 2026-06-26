import { describe, expect, it } from 'vitest';
import { marketKey, type MarketKey } from '../domain/market.js';
import { createRiskState, onAnomaly } from '../risk/manager.js';
import type { RiskConfig } from '../risk/types.js';
import type { Signal } from '../signal/types.js';
import {
  decimalOddsMilli,
  microUsd,
  prob,
  usdToMicroUsd,
  type DecimalOddsMilli,
  type MicroUsd,
  type Prob,
} from '../units.js';
import { buildDecision, type DecisionConfig } from './build.js';

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

const riskConfig: RiskConfig = {
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

const decisionConfig: DecisionConfig = {
  kelly: { fraction: 0.25, maxFractionOfBankroll: 0.05 },
  risk: riskConfig,
};

const context = { consensusFairProb: probOf(0.5), dispersion: 0 };

const makeSignal = (overrides: Partial<Signal>): Signal => ({
  kind: 'divergence',
  fixtureId: 1,
  marketKey: MARKET,
  outcome: 'home',
  tsMs: 1000,
  fairProb: probOf(0.5),
  offeredOddsMilli: oddsOf(2200),
  edge: 0.1,
  strength: 0.045,
  ...overrides,
});

describe('buildDecision', () => {
  it('builds a Kelly-sized, risk-approved decision', () => {
    const result = buildDecision(
      {
        signal: makeSignal({}),
        riskState: createRiskState(micro(1000)),
        riskContext: context,
        nowMs: 1000,
        feedTsMs: 1000,
      },
      decisionConfig,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === 'decision') {
      const { decision } = result.value;
      expect(decision.outcome).toBe('home');
      expect(decision.entryOddsMilli).toBe(2200);
      expect(decision.signalKind).toBe('divergence');
      expect(decision.stake > 0n).toBe(true);
    } else {
      throw new Error('expected a decision');
    }
  });

  it('skips when a breaker is latched', () => {
    const state = onAnomaly(createRiskState(micro(1000)), 'root-mismatch');
    const result = buildDecision(
      { signal: makeSignal({}), riskState: state, riskContext: context, nowMs: 1000, feedTsMs: 1000 },
      decisionConfig,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === 'skipped') {
      expect(result.value.reason).toBe('risk-blocked');
      expect(result.value.detail).toBe('root-mismatch');
    }
  });

  it('skips with no-edge when the Kelly stake quantizes to zero', () => {
    const tiny = microUsd(1n);
    expect(tiny.ok).toBe(true);
    if (tiny.ok) {
      const result = buildDecision(
        {
          signal: makeSignal({}),
          riskState: createRiskState(tiny.value),
          riskContext: context,
          nowMs: 1000,
          feedTsMs: 1000,
        },
        decisionConfig,
      );
      if (result.ok && result.value.kind === 'skipped') {
        expect(result.value.reason).toBe('no-edge');
      }
    }
  });

  it('errors on a malformed Kelly config', () => {
    const result = buildDecision(
      {
        signal: makeSignal({}),
        riskState: createRiskState(micro(1000)),
        riskContext: context,
        nowMs: 1000,
        feedTsMs: 1000,
      },
      { kelly: { fraction: 0, maxFractionOfBankroll: 0.5 }, risk: riskConfig },
    );
    expect(result.ok).toBe(false);
  });
});
