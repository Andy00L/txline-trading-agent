import { describe, expect, it } from 'vitest';
import { decimalOddsMilli, microUsd, prob, usdToMicroUsd } from '../units.js';
import type { DecimalOddsMilli, MicroUsd, Prob } from '../units.js';
import { kellyStake } from './kelly.js';

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

const bankrollOf = (usd: number): MicroUsd => {
  const result = usdToMicroUsd(usd);
  if (!result.ok) {
    throw new Error(`bad bankroll ${usd}`);
  }
  return result.value;
};

const halfKelly = { fraction: 0.5, maxFractionOfBankroll: 0.5 };

describe('kellyStake', () => {
  it('stakes fractional Kelly when there is an edge', () => {
    // p=0.75, odds 2.0 (b=1): f* = 0.75 - 0.25 = 0.5; half-Kelly = 0.25 of 1000 USD = 250 USD.
    // Inputs are exactly representable in IEEE754 so the floored stake is exact.
    const stake = kellyStake(probOf(0.75), oddsOf(2000), bankrollOf(1000), halfKelly);
    expect(stake.ok).toBe(true);
    if (stake.ok) {
      expect(stake.value).toBe(250_000_000n);
    }
  });

  it('stakes 0 when there is no edge', () => {
    const stake = kellyStake(probOf(0.4), oddsOf(2000), bankrollOf(1000), halfKelly);
    expect(stake.ok).toBe(true);
    if (stake.ok) {
      expect(stake.value).toBe(0n);
    }
  });

  it('caps the stake at maxFractionOfBankroll', () => {
    // p=0.9, odds 2.0 (b=1): f* = 0.8; full fraction but cap 0.05 -> 0.05 of 1000 USD = 50 USD.
    const stake = kellyStake(probOf(0.9), oddsOf(2000), bankrollOf(1000), {
      fraction: 1,
      maxFractionOfBankroll: 0.05,
    });
    expect(stake.ok).toBe(true);
    if (stake.ok) {
      expect(stake.value).toBe(50_000_000n);
    }
  });

  it('quantizes a sub-micro stake down to 0', () => {
    const tinyBankroll = microUsd(5n);
    expect(tinyBankroll.ok).toBe(true);
    if (tinyBankroll.ok) {
      const stake = kellyStake(probOf(0.6), oddsOf(2000), tinyBankroll.value, halfKelly);
      expect(stake.ok).toBe(true);
      if (stake.ok) {
        expect(stake.value).toBe(0n);
      }
    }
  });

  it('rejects an invalid config', () => {
    expect(kellyStake(probOf(0.6), oddsOf(2000), bankrollOf(1000), {
      fraction: 0,
      maxFractionOfBankroll: 0.5,
    }).ok).toBe(false);
    expect(kellyStake(probOf(0.6), oddsOf(2000), bankrollOf(1000), {
      fraction: 0.5,
      maxFractionOfBankroll: 1.5,
    }).ok).toBe(false);
  });

  it('stakes 0 at a boundary probability of 1 (untrustworthy certainty, not a max bet)', () => {
    const stake = kellyStake(probOf(1), oddsOf(2000), bankrollOf(1000), halfKelly);
    expect(stake.ok).toBe(true);
    if (stake.ok) {
      expect(stake.value).toBe(0n);
    }
  });

  it('stakes 0 at a boundary probability of 0', () => {
    const stake = kellyStake(probOf(0), oddsOf(2000), bankrollOf(1000), halfKelly);
    expect(stake.ok).toBe(true);
    if (stake.ok) {
      expect(stake.value).toBe(0n);
    }
  });
});
