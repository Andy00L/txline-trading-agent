import { describe, expect, it } from 'vitest';
import { SeededPrng } from '@txline-agent/core';
import { computeBackoffMs, type BackoffConfig } from './backoff.js';

const config: BackoffConfig = { baseMs: 100, maxMs: 1000, maxAttempts: 5 };

describe('computeBackoffMs', () => {
  it('is deterministic for the same seed and attempt', () => {
    expect(computeBackoffMs(0, config, new SeededPrng(7))).toBe(
      computeBackoffMs(0, config, new SeededPrng(7)),
    );
  });

  it('stays under the per-attempt ceiling base * 2^attempt', () => {
    for (let trial = 0; trial < 50; trial += 1) {
      expect(computeBackoffMs(0, config, new SeededPrng(trial))).toBeLessThan(100);
      expect(computeBackoffMs(1, config, new SeededPrng(trial))).toBeLessThan(200);
    }
  });

  it('caps at maxMs for large attempts', () => {
    for (let trial = 0; trial < 50; trial += 1) {
      expect(computeBackoffMs(20, config, new SeededPrng(trial))).toBeLessThan(1000);
    }
  });
});
