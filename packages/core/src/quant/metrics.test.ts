import { describe, expect, it } from 'vitest';
import { SeededPrng } from '../prng.js';
import { decimalOddsMilli, prob } from '../units.js';
import type { DecimalOddsMilli, Prob } from '../units.js';
import {
  bootstrapMeanCi,
  brierScore,
  buildCalibrationCurve,
  closingLineValueOdds,
  closingLineValueProb,
  logLoss,
  type CalibrationSample,
} from './metrics.js';

const probOf = (value: number): Prob => {
  const result = prob(value);
  if (!result.ok) {
    throw new Error(`bad prob ${value}`);
  }
  return result.value;
};

const oddsOf = (milli: number): DecimalOddsMilli => {
  const odds = decimalOddsMilli(milli);
  if (!odds.ok) {
    throw new Error(`bad odds ${milli}`);
  }
  return odds.value;
};

const sample = (predicted: number, outcome: 0 | 1): CalibrationSample => ({
  predicted: probOf(predicted),
  outcome,
});

describe('brierScore', () => {
  it('is 0 for perfectly confident, correct predictions', () => {
    const result = brierScore([sample(1, 1), sample(0, 0)]);
    if (result.ok) {
      expect(result.value).toBeCloseTo(0, 12);
    }
  });

  it('is 0.25 for coin-flip predictions', () => {
    const result = brierScore([sample(0.5, 1), sample(0.5, 0)]);
    if (result.ok) {
      expect(result.value).toBeCloseTo(0.25, 12);
    }
  });

  it('errors on an empty sample', () => {
    expect(brierScore([]).ok).toBe(false);
  });
});

describe('logLoss', () => {
  it('is near 0 for confident, correct predictions', () => {
    const result = logLoss([sample(1, 1), sample(0, 0)]);
    if (result.ok) {
      expect(result.value).toBeCloseTo(0, 6);
    }
  });

  it('is ln(2) for coin-flip predictions', () => {
    const result = logLoss([sample(0.5, 1), sample(0.5, 0)]);
    if (result.ok) {
      expect(result.value).toBeCloseTo(Math.log(2), 9);
    }
  });
});

describe('buildCalibrationCurve', () => {
  it('bins predictions and reports the fraction of positives', () => {
    const result = buildCalibrationCurve(
      [sample(0.1, 0), sample(0.1, 0), sample(0.9, 1), sample(1, 1)],
      10,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const curve = result.value;
      expect(curve.length).toBe(10);
      expect(curve[0]?.count).toBe(0);
      expect(curve[1]?.count).toBe(2);
      expect(curve[1]?.fractionPositive).toBe(0);
      expect(curve[1]?.meanPredicted).toBeCloseTo(0.1, 12);
      // 0.9 lands in bin 9 and a prediction of exactly 1.0 is clamped into the top bin.
      expect(curve[9]?.count).toBe(2);
      expect(curve[9]?.fractionPositive).toBe(1);
    }
  });

  it('errors on an empty sample', () => {
    expect(buildCalibrationCurve([]).ok).toBe(false);
  });
});

describe('closing line value', () => {
  it('odds-based CLV is positive when the entry beats the close', () => {
    expect(closingLineValueOdds(oddsOf(2100), oddsOf(2000))).toBeCloseTo(0.05, 12);
  });

  it('probability-based CLV is positive when the entry implies a lower prob than the close', () => {
    expect(closingLineValueProb(probOf(0.45), probOf(0.5))).toBeCloseTo(0.05, 12);
  });
});

describe('bootstrapMeanCi', () => {
  it('returns null for an empty sample', () => {
    expect(bootstrapMeanCi([], new SeededPrng(1))).toBeNull();
  });

  it('brackets the observed mean and is deterministic for a fixed seed', () => {
    const values = [0.01, 0.02, -0.005, 0.03, 0.015, 0.008, 0.02, -0.01, 0.025, 0.012];
    const first = bootstrapMeanCi(values, new SeededPrng(1));
    const second = bootstrapMeanCi(values, new SeededPrng(1));
    expect(first).not.toBeNull();
    if (first && second) {
      expect(first.lower).toBe(second.lower);
      expect(first.upper).toBe(second.upper);
      expect(first.lower).toBeLessThanOrEqual(first.mean);
      expect(first.upper).toBeGreaterThanOrEqual(first.mean);
    }
  });

  it('collapses to the constant for a zero-variance sample', () => {
    const result = bootstrapMeanCi([0.5, 0.5, 0.5], new SeededPrng(7));
    if (result) {
      expect(result.mean).toBeCloseTo(0.5, 12);
      expect(result.lower).toBeCloseTo(0.5, 12);
      expect(result.upper).toBeCloseTo(0.5, 12);
    }
  });

  it('yields a positive lower bound for a clearly positive sample', () => {
    const values = Array.from({ length: 50 }, () => 0.1);
    const result = bootstrapMeanCi(values, new SeededPrng(3));
    if (result) {
      expect(result.lower).toBeGreaterThan(0);
    }
  });
});
