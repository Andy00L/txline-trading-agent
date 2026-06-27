import { describe, expect, it } from 'vitest';
import { decimalOddsMilli } from '../units.js';
import type { OddsLine, Outcome } from '../domain/market.js';
import { computeFairBook, devigMultiplicative, devigShin } from './devig.js';

const line = (outcome: Outcome, milli: number): OddsLine => {
  const odds = decimalOddsMilli(milli);
  if (!odds.ok) {
    throw new Error(`bad odds milli ${milli}`);
  }
  return { outcome, decimalOddsMilli: odds.value, impliedPct: null };
};

const sumFair = (book: { outcomes: readonly { fairProb: number }[] }): number =>
  book.outcomes.reduce((sum, entry) => sum + entry.fairProb, 0);

describe('devigMultiplicative', () => {
  it('normalizes implied probabilities by the booksum', () => {
    const result = devigMultiplicative([line('home', 1900), line('draw', 3400), line('away', 3600)]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const book = result.value;
      const expectedBooksum = 1000 / 1900 + 1000 / 3400 + 1000 / 3600;
      expect(book.booksum).toBeCloseTo(expectedBooksum, 10);
      expect(book.overround).toBeCloseTo(expectedBooksum - 1, 10);
      expect(sumFair(book)).toBeCloseTo(1, 10);
      expect(book.outcomes[0]?.fairProb).toBeCloseTo(1000 / 1900 / expectedBooksum, 10);
      expect(book.shinZ).toBeNull();
    }
  });

  it('errors on an empty market', () => {
    expect(devigMultiplicative([]).ok).toBe(false);
  });

  it('errors on a single-line (degenerate) book that would imply probability 1.0', () => {
    const result = devigMultiplicative([line('home', 1900)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('degenerate-book');
    }
  });
});

describe('devigShin', () => {
  const favouriteMarket = [line('home', 1500), line('draw', 4500), line('away', 7000)];

  it('produces probabilities that sum to 1 with z in [0,1)', () => {
    const result = devigShin(favouriteMarket);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(sumFair(result.value)).toBeCloseTo(1, 9);
      const shinZ = result.value.shinZ;
      expect(shinZ).not.toBeNull();
      if (shinZ !== null) {
        expect(shinZ).toBeGreaterThan(0);
        expect(shinZ).toBeLessThan(1);
      }
    }
  });

  it('each fair probability satisfies the Shin quadratic (internal consistency)', () => {
    const result = devigShin(favouriteMarket);
    if (result.ok && result.value.shinZ !== null) {
      const { booksum, shinZ } = result.value;
      const milliByOutcome = new Map<Outcome, number>([
        ['home', 1500],
        ['draw', 4500],
        ['away', 7000],
      ]);
      for (const entry of result.value.outcomes) {
        const impliedProb = 1000 / (milliByOutcome.get(entry.outcome) ?? Number.NaN);
        const residual =
          (1 - shinZ) * entry.fairProb ** 2 +
          shinZ * entry.fairProb -
          (impliedProb * impliedProb) / booksum;
        expect(Math.abs(residual)).toBeLessThan(1e-6);
      }
    }
  });

  it('keeps a symmetric market symmetric with a positive z', () => {
    const result = devigShin([line('home', 2700), line('draw', 2700), line('away', 2700)]);
    if (result.ok) {
      for (const entry of result.value.outcomes) {
        expect(entry.fairProb).toBeCloseTo(1 / 3, 9);
      }
      expect(result.value.shinZ).not.toBeNull();
      if (result.value.shinZ !== null) {
        expect(result.value.shinZ).toBeGreaterThan(0);
      }
    }
  });

  it('approaches multiplicative as the margin shrinks', () => {
    const lines = [line('home', 1999), line('draw', 3998), line('away', 3998)];
    const shin = devigShin(lines);
    const mult = devigMultiplicative(lines);
    if (shin.ok && mult.ok) {
      for (let index = 0; index < 3; index += 1) {
        expect(shin.value.outcomes[index]?.fairProb).toBeCloseTo(
          mult.value.outcomes[index]?.fairProb ?? Number.NaN,
          3,
        );
      }
    }
  });

  it('shifts probability toward the favourite versus multiplicative', () => {
    const shin = devigShin(favouriteMarket);
    const mult = devigMultiplicative(favouriteMarket);
    if (shin.ok && mult.ok) {
      const shinFavourite = shin.value.outcomes[0]?.fairProb ?? 0;
      const multFavourite = mult.value.outcomes[0]?.fairProb ?? 0;
      const shinLongshot = shin.value.outcomes[2]?.fairProb ?? 0;
      const multLongshot = mult.value.outcomes[2]?.fairProb ?? 0;
      expect(shinFavourite).toBeGreaterThan(multFavourite);
      expect(shinLongshot).toBeLessThan(multLongshot);
    }
  });

  it('falls back to multiplicative when there is no margin', () => {
    const result = devigShin([line('home', 2000), line('draw', 4000), line('away', 4000)]);
    if (result.ok) {
      expect(result.value.shinZ).toBe(0);
      expect(result.value.outcomes[0]?.fairProb).toBeCloseTo(0.5, 12);
    }
  });

  it('errors on a single-line (degenerate) book', () => {
    const result = devigShin([line('home', 1900)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('degenerate-book');
    }
  });
});

describe('computeFairBook', () => {
  it('dispatches by method', () => {
    const lines = [line('home', 1900), line('draw', 3400), line('away', 3600)];
    expect(computeFairBook(lines, 'multiplicative').ok).toBe(true);
    const shin = computeFairBook(lines, 'shin');
    expect(shin.ok).toBe(true);
    if (shin.ok) {
      expect(shin.value.method).toBe('shin');
    }
  });
});
