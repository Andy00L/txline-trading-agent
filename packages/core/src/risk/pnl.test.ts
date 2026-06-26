import { describe, expect, it } from 'vitest';
import { decimalOddsMilli, usdToMicroUsd, type DecimalOddsMilli, type MicroUsd } from '../units.js';
import { computePnl } from './pnl.js';

const oddsOf = (milli: number): DecimalOddsMilli => {
  const odds = decimalOddsMilli(milli);
  if (!odds.ok) {
    throw new Error(`bad odds ${milli}`);
  }
  return odds.value;
};

const micro = (usd: number): MicroUsd => {
  const result = usdToMicroUsd(usd);
  if (!result.ok) {
    throw new Error(`bad usd ${usd}`);
  }
  return result.value;
};

describe('computePnl', () => {
  it('returns the profit on a win', () => {
    expect(computePnl(true, micro(100), oddsOf(2000))).toBe(100_000_000n);
    expect(computePnl(true, micro(100), oddsOf(3000))).toBe(200_000_000n);
  });

  it('returns minus the stake on a loss', () => {
    expect(computePnl(false, micro(100), oddsOf(2000))).toBe(-100_000_000n);
  });
});
