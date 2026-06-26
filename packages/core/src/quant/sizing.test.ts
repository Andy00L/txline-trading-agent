import { describe, expect, it } from 'vitest';
import { microUsdSaturating } from '../units.js';
import { steamStake } from './sizing.js';

const BANKROLL = microUsdSaturating(1_000_000_000n); // 1000 USDC

describe('steamStake', () => {
  it('stakes the base fraction plus a strength-scaled amount', () => {
    const result = steamStake(0.05, BANKROLL, {
      baseFraction: 0.01,
      strengthScale: 0.5,
      maxFraction: 0.1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // 0.01 + 0.5 * 0.05 = 0.035 of 1e9 micro-USD.
    expect(result.value).toBe(35_000_000n);
  });

  it('caps the staked fraction at maxFraction', () => {
    const result = steamStake(10, BANKROLL, {
      baseFraction: 0.01,
      strengthScale: 1,
      maxFraction: 0.1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toBe(100_000_000n);
  });

  it('does not require positive entry EV (sizes a fair-odds steam bet)', () => {
    const result = steamStake(0.04, BANKROLL, {
      baseFraction: 0.02,
      strengthScale: 0,
      maxFraction: 0.1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value > 0n).toBe(true);
  });

  it('rejects an out-of-range maxFraction', () => {
    const result = steamStake(0.05, BANKROLL, {
      baseFraction: 0.01,
      strengthScale: 0.5,
      maxFraction: 0,
    });
    expect(result.ok).toBe(false);
  });
});
