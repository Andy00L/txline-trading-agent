import { describe, expect, it } from 'vitest';
import { SeededPrng } from './prng.js';

describe('SeededPrng', () => {
  it('produces values in [0, 1)', () => {
    const prng = new SeededPrng(123);
    for (let index = 0; index < 100; index += 1) {
      const value = prng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is deterministic given the same seed', () => {
    const first = new SeededPrng(42);
    const second = new SeededPrng(42);
    const firstSequence = [first.next(), first.next(), first.next()];
    const secondSequence = [second.next(), second.next(), second.next()];
    expect(firstSequence).toEqual(secondSequence);
  });

  it('diverges for different seeds', () => {
    const first = new SeededPrng(1);
    const second = new SeededPrng(2);
    expect(first.next()).not.toBe(second.next());
  });
});
