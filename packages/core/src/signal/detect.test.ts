import { describe, expect, it } from 'vitest';
import { marketKey, type MarketKey } from '../domain/market.js';
import { decimalOddsMilli, prob, type DecimalOddsMilli, type Prob } from '../units.js';
import { detectDivergence, detectSteam, type ProbObservation } from './detect.js';

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

const MARKET: MarketKey = marketKey({
  fixtureId: 1,
  superOddsType: 'StablePrice',
  marketPeriod: 'FT',
  marketParameters: '',
});

const divergenceConfig = { minEdge: 0.02, minProb: 0.05, maxProb: 0.95 };

describe('detectDivergence', () => {
  it('signals when the offered odds beat the consensus fair probability', () => {
    const signal = detectDivergence(
      {
        fixtureId: 1,
        marketKey: MARKET,
        outcome: 'home',
        tsMs: 1000,
        fairProb: probOf(0.5),
        offeredOddsMilli: oddsOf(2200),
      },
      divergenceConfig,
    );
    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe('divergence');
    expect(signal?.edge).toBeCloseTo(0.1, 10);
    expect(signal?.strength).toBeCloseTo(0.5 - 1000 / 2200, 10);
  });

  it('returns null when the offered odds give no edge', () => {
    const signal = detectDivergence(
      {
        fixtureId: 1,
        marketKey: MARKET,
        outcome: 'home',
        tsMs: 1000,
        fairProb: probOf(0.5),
        offeredOddsMilli: oddsOf(1900),
      },
      divergenceConfig,
    );
    expect(signal).toBeNull();
  });

  it('returns null for an extreme favourite outside the probability band', () => {
    const signal = detectDivergence(
      {
        fixtureId: 1,
        marketKey: MARKET,
        outcome: 'home',
        tsMs: 1000,
        fairProb: probOf(0.97),
        offeredOddsMilli: oddsOf(1100),
      },
      divergenceConfig,
    );
    expect(signal).toBeNull();
  });
});

const steamConfig = { windowMs: 5000, minProbMove: 0.03, minEdge: 0.02 };

describe('detectSteam', () => {
  it('signals on a sharp upward move with remaining edge', () => {
    const history: ProbObservation[] = [
      { tsMs: 0, fairProb: probOf(0.4) },
      { tsMs: 1000, fairProb: probOf(0.42) },
      { tsMs: 2000, fairProb: probOf(0.46) },
    ];
    const signal = detectSteam(
      {
        fixtureId: 1,
        marketKey: MARKET,
        outcome: 'home',
        tsMs: 2000,
        history,
        offeredOddsMilli: oddsOf(2300),
      },
      steamConfig,
    );
    expect(signal).not.toBeNull();
    expect(signal?.kind).toBe('steam');
    expect(signal?.strength).toBeCloseTo(0.06, 10);
    expect(signal?.fairProb).toBeCloseTo(0.46, 10);
  });

  it('returns null when the move is too small', () => {
    const history: ProbObservation[] = [
      { tsMs: 0, fairProb: probOf(0.45) },
      { tsMs: 2000, fairProb: probOf(0.46) },
    ];
    const signal = detectSteam(
      {
        fixtureId: 1,
        marketKey: MARKET,
        outcome: 'home',
        tsMs: 2000,
        history,
        offeredOddsMilli: oddsOf(2300),
      },
      steamConfig,
    );
    expect(signal).toBeNull();
  });

  it('ignores observations outside the look-back window', () => {
    const history: ProbObservation[] = [
      { tsMs: 0, fairProb: probOf(0.4) },
      { tsMs: 9000, fairProb: probOf(0.46) },
    ];
    const signal = detectSteam(
      {
        fixtureId: 1,
        marketKey: MARKET,
        outcome: 'home',
        tsMs: 9000,
        history,
        offeredOddsMilli: oddsOf(2300),
      },
      steamConfig,
    );
    expect(signal).toBeNull();
  });
});
