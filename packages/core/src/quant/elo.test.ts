import { describe, expect, it } from 'vitest';
import {
  applyEloMatch,
  decorrelationMultiplier,
  DEFAULT_DECORRELATION_CONFIG,
  DEFAULT_ELO_CONFIG,
  DEFAULT_ELO_PROB_CONFIG,
  eloExpectedScore,
  eloMatchProbs,
} from './elo.js';
import { clampProb } from '../units.js';

describe('eloExpectedScore', () => {
  it('is 0.5 for equal ratings at a neutral venue', () => {
    expect(eloExpectedScore(1500, 1500, true, DEFAULT_ELO_CONFIG)).toBeCloseTo(0.5, 12);
  });

  it('adds the home advantage only at a non-neutral venue', () => {
    // difference = 100, expected = 1 / (1 + 10^(-100/400)).
    expect(eloExpectedScore(1500, 1500, false, DEFAULT_ELO_CONFIG)).toBeCloseTo(0.640065, 6);
    // The same equal ratings at a neutral venue drop the term back to 0.5.
    expect(eloExpectedScore(1500, 1500, true, DEFAULT_ELO_CONFIG)).toBeCloseTo(0.5, 12);
  });

  it('matches the closed form for a 400-point edge', () => {
    expect(eloExpectedScore(1900, 1500, true, DEFAULT_ELO_CONFIG)).toBeCloseTo(1 / 1.1, 12);
  });
});

describe('applyEloMatch', () => {
  it('moves a one-goal home win by K/2 between equal teams and is zero-sum', () => {
    const ratings = applyEloMatch(
      new Map([
        [1, 1500],
        [2, 1500],
      ]),
      { homeTeam: 1, awayTeam: 2, homeGoals: 1, awayGoals: 0, neutral: true },
      DEFAULT_ELO_CONFIG,
    );
    // delta = K * G * (actual - expected) = 60 * 1 * (1 - 0.5) = 30.
    expect(ratings.get(1)).toBeCloseTo(1530, 9);
    expect(ratings.get(2)).toBeCloseTo(1470, 9);
    const a = ratings.get(1) ?? Number.NaN;
    const b = ratings.get(2) ?? Number.NaN;
    expect(a - 1500 + (b - 1500)).toBeCloseTo(0, 9);
  });

  it('amplifies a three-goal win through the goal-difference multiplier', () => {
    const ratings = applyEloMatch(
      new Map([
        [1, 1500],
        [2, 1500],
      ]),
      { homeTeam: 1, awayTeam: 2, homeGoals: 3, awayGoals: 0, neutral: true },
      DEFAULT_ELO_CONFIG,
    );
    // G = (11 + 3) / 8 = 1.75; delta = 60 * 1.75 * 0.5 = 52.5.
    expect(ratings.get(1)).toBeCloseTo(1552.5, 9);
    expect(ratings.get(2)).toBeCloseTo(1447.5, 9);
  });

  it('leaves equal teams unchanged after a draw and does not mutate the input', () => {
    const input = new Map([
      [1, 1500],
      [2, 1500],
    ]);
    const ratings = applyEloMatch(
      input,
      { homeTeam: 1, awayTeam: 2, homeGoals: 1, awayGoals: 1, neutral: true },
      DEFAULT_ELO_CONFIG,
    );
    expect(ratings.get(1)).toBeCloseTo(1500, 9);
    expect(ratings.get(2)).toBeCloseTo(1500, 9);
    // The input table is untouched, so a caller can keep a walk-forward history.
    expect(input.get(1)).toBe(1500);
  });

  it('starts an unseen team at the initial rating', () => {
    const ratings = applyEloMatch(
      new Map(),
      { homeTeam: 7, awayTeam: 9, homeGoals: 2, awayGoals: 0, neutral: true },
      DEFAULT_ELO_CONFIG,
    );
    // Both begin at 1500; a two-goal win gives delta = 60 * 1.5 * 0.5 = 45.
    expect(ratings.get(7)).toBeCloseTo(1545, 9);
    expect(ratings.get(9)).toBeCloseTo(1455, 9);
  });
});

describe('eloMatchProbs', () => {
  it('is symmetric for equal ratings and reproduces the expected score', () => {
    const probs = eloMatchProbs(1500, 1500, true, DEFAULT_ELO_CONFIG, DEFAULT_ELO_PROB_CONFIG);
    expect(probs.home).toBeCloseTo(probs.away, 3);
    expect(probs.home + probs.draw + probs.away).toBeCloseTo(1, 9);
    // The 1X2 split reproduces the Elo expected score (home win plus half the draw).
    expect(probs.home + 0.5 * probs.draw).toBeCloseTo(0.5, 3);
    expect(probs.draw).toBeGreaterThan(0);
    expect(probs.draw).toBeLessThan(1);
  });

  it('tilts toward the stronger side and still reproduces the expected score', () => {
    const probs = eloMatchProbs(1700, 1500, true, DEFAULT_ELO_CONFIG, DEFAULT_ELO_PROB_CONFIG);
    expect(probs.home).toBeGreaterThan(probs.away);
    const expected = eloExpectedScore(1700, 1500, true, DEFAULT_ELO_CONFIG);
    expect(probs.home + 0.5 * probs.draw).toBeCloseTo(expected, 3);
  });
});

describe('decorrelationMultiplier', () => {
  it('leaves the stake unchanged inside the deadband', () => {
    // logit(0.52) - logit(0.50) is about 0.08, under the 0.12 deadband.
    expect(
      decorrelationMultiplier(clampProb(0.52), clampProb(0.5), DEFAULT_DECORRELATION_CONFIG),
    ).toBe(1);
  });

  it('scales the stake up when the rating corroborates the back', () => {
    // residual = logit(0.5) - logit(0.4) = 0.405465; 1 + 0.5 * (0.405465 - 0.12) = 1.142733.
    expect(
      decorrelationMultiplier(clampProb(0.5), clampProb(0.4), DEFAULT_DECORRELATION_CONFIG),
    ).toBeCloseTo(1.142733, 6);
  });

  it('caps the upward multiplier on strong corroboration', () => {
    expect(
      decorrelationMultiplier(clampProb(0.6), clampProb(0.3), DEFAULT_DECORRELATION_CONFIG),
    ).toBe(DEFAULT_DECORRELATION_CONFIG.maxMultiplier);
  });

  it('cuts the stake when the rating contradicts the back', () => {
    expect(
      decorrelationMultiplier(clampProb(0.4), clampProb(0.5), DEFAULT_DECORRELATION_CONFIG),
    ).toBe(DEFAULT_DECORRELATION_CONFIG.contradictMultiplier);
  });

  it('never returns zero, so the rating only modulates the primary signal', () => {
    // Even a maximal contradiction returns the bounded cut, not a hard veto.
    const extreme = decorrelationMultiplier(
      clampProb(0.01),
      clampProb(0.99),
      DEFAULT_DECORRELATION_CONFIG,
    );
    expect(extreme).toBe(DEFAULT_DECORRELATION_CONFIG.contradictMultiplier);
    expect(extreme).toBeGreaterThan(0);
  });
});
