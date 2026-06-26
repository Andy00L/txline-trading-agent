import { describe, expect, it } from 'vitest';
import { ok, type Result } from './result.js';
import {
  decimalOddsMilli,
  decimalOddsMilliToProb,
  decimalOddsMilliToString,
  microUsd,
  microUsdSaturating,
  pctStringToProb,
  prob,
  probToBps,
  probToDecimalOddsMilli,
  usdToMicroUsd,
  type UnitError,
} from './units.js';

const unwrap = <TValue>(result: Result<TValue, UnitError>): TValue => {
  if (!result.ok) {
    throw new Error(`unexpected error: ${JSON.stringify(result.error)}`);
  }
  return result.value;
};

describe('decimalOddsMilli', () => {
  it('accepts a finite integer above 1000', () => {
    expect(decimalOddsMilli(2000)).toEqual(ok(2000));
  });

  it('rejects 1000 and below (decimal odds must exceed 1.0)', () => {
    expect(decimalOddsMilli(1000).ok).toBe(false);
    expect(decimalOddsMilli(900).ok).toBe(false);
  });

  it('rejects non-integers and non-finite values', () => {
    expect(decimalOddsMilli(1999.5).ok).toBe(false);
    expect(decimalOddsMilli(Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(decimalOddsMilli(Number.NaN).ok).toBe(false);
  });
});

describe('odds and probability conversion', () => {
  it('maps decimal odds to implied probability', () => {
    expect(decimalOddsMilliToProb(unwrap(decimalOddsMilli(2000)))).toBeCloseTo(0.5, 10);
    expect(decimalOddsMilliToProb(unwrap(decimalOddsMilli(4000)))).toBeCloseTo(0.25, 10);
    expect(decimalOddsMilliToProb(unwrap(decimalOddsMilli(1250)))).toBeCloseTo(0.8, 10);
  });

  it('maps probability back to decimal odds, rounded', () => {
    expect(probToDecimalOddsMilli(unwrap(prob(0.5)))).toEqual(ok(2000));
    expect(probToDecimalOddsMilli(unwrap(prob(0.8)))).toEqual(ok(1250));
  });

  it('rejects a probability of 0 or 1 when deriving bettable odds', () => {
    expect(probToDecimalOddsMilli(unwrap(prob(0))).ok).toBe(false);
    expect(probToDecimalOddsMilli(unwrap(prob(1))).ok).toBe(false);
  });

  it('round-trips odds through probability', () => {
    const implied = decimalOddsMilliToProb(unwrap(decimalOddsMilli(1250)));
    expect(implied).toBeCloseTo(0.8, 10);
    expect(unwrap(probToDecimalOddsMilli(implied))).toBe(1250);
  });

  it('formats decimal-odds-milli with three decimals', () => {
    expect(decimalOddsMilliToString(unwrap(decimalOddsMilli(2000)))).toBe('2.000');
    expect(decimalOddsMilliToString(unwrap(decimalOddsMilli(1500)))).toBe('1.500');
  });
});

describe('prob', () => {
  it('accepts the closed interval [0, 1]', () => {
    expect(prob(0)).toEqual(ok(0));
    expect(prob(1)).toEqual(ok(1));
    expect(prob(0.5)).toEqual(ok(0.5));
  });

  it('rejects values outside [0, 1] and non-finite values', () => {
    expect(prob(-0.01).ok).toBe(false);
    expect(prob(1.01).ok).toBe(false);
    expect(prob(Number.NaN).ok).toBe(false);
  });
});

describe('pctStringToProb', () => {
  it('parses a three-decimal percentage to a probability', () => {
    expect(unwrap(pctStringToProb('52.632'))).toBeCloseTo(0.52632, 10);
    expect(unwrap(pctStringToProb('50.000'))).toBeCloseTo(0.5, 10);
    expect(unwrap(pctStringToProb('100.000'))).toBeCloseTo(1, 10);
    expect(unwrap(pctStringToProb('0.000'))).toBe(0);
  });

  it('maps NA to null', () => {
    expect(pctStringToProb('NA')).toEqual(ok(null));
  });

  it('rejects malformed percentages', () => {
    expect(pctStringToProb('52.63').ok).toBe(false);
    expect(pctStringToProb('52').ok).toBe(false);
    expect(pctStringToProb('abc').ok).toBe(false);
  });
});

describe('money', () => {
  it('builds non-negative MicroUsd', () => {
    expect(microUsd(1_000_000n)).toEqual(ok(1_000_000n));
    expect(microUsd(-1n).ok).toBe(false);
  });

  it('converts whole USD to MicroUsd', () => {
    expect(usdToMicroUsd(1)).toEqual(ok(1_000_000n));
    expect(usdToMicroUsd(0.5)).toEqual(ok(500_000n));
    expect(usdToMicroUsd(-1).ok).toBe(false);
  });

  it('saturates negative computed amounts to 0', () => {
    expect(microUsdSaturating(250n)).toBe(250n);
    expect(microUsdSaturating(-5n)).toBe(0n);
  });
});

describe('probToBps', () => {
  it('rounds a probability to basis points', () => {
    expect(probToBps(unwrap(prob(0.5)))).toBe(5000);
    expect(probToBps(unwrap(prob(0.52632)))).toBe(5263);
    expect(probToBps(unwrap(prob(1)))).toBe(10_000);
  });
});
