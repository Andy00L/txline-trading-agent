import { describe, expect, it } from 'vitest';
import { decimalOddsMilli, prob } from '../units.js';
import type { DecimalOddsMilli, Prob } from '../units.js';
import { expectedValue } from './ev.js';

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

describe('expectedValue', () => {
  it('is positive when the fair probability beats the implied', () => {
    expect(expectedValue(probOf(0.6), oddsOf(2000))).toBeCloseTo(0.2, 12);
  });

  it('is negative when the fair probability is below the implied', () => {
    expect(expectedValue(probOf(0.4), oddsOf(2000))).toBeCloseTo(-0.2, 12);
  });

  it('is zero at fair odds', () => {
    expect(expectedValue(probOf(0.5), oddsOf(2000))).toBeCloseTo(0, 12);
  });
});
