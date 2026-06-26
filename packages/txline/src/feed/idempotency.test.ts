import { describe, expect, it } from 'vitest';
import { IdempotencyTracker } from './idempotency.js';

describe('IdempotencyTracker', () => {
  it('accepts an odds messageId only once', () => {
    const tracker = new IdempotencyTracker();
    expect(tracker.acceptOdds('m1')).toBe(true);
    expect(tracker.acceptOdds('m1')).toBe(false);
    expect(tracker.acceptOdds('m2')).toBe(true);
  });

  it('accepts a score (fixtureId, seq) only once', () => {
    const tracker = new IdempotencyTracker();
    expect(tracker.acceptScore(1, 10)).toBe(true);
    expect(tracker.acceptScore(1, 10)).toBe(false);
    expect(tracker.acceptScore(1, 11)).toBe(true);
    expect(tracker.acceptScore(2, 10)).toBe(true);
  });
});
