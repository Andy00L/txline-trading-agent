import { describe, expect, it } from 'vitest';
import { clampProb } from '../units.js';
import { poissonPmf, scorelineMatrix } from './poisson.js';
import {
  DEFAULT_GOALS_MODEL_CONFIG,
  fitGoalsModel,
  handicapCover,
  legEdges,
  matchResultProbs,
  overProb,
  supremacyTotalToRates,
  type GoalsModelConfig,
  type ObservedLeg,
} from './surface.js';

/** Build an exact, internally consistent surface from a known (supremacy, total): every
 * leg's market probability is the model probability, so a correct fit recovers the planted
 * parameters with near-zero residual. */
const exactSurface = (
  supremacy: number,
  total: number,
  rho: number,
  maxGoals: number,
): ObservedLeg[] => {
  const rates = supremacyTotalToRates(supremacy, total);
  const matrix = scorelineMatrix({ homeRate: rates.homeRate, awayRate: rates.awayRate, rho, maxGoals });
  const match = matchResultProbs(matrix);
  const over25 = overProb(matrix, 2.5);
  const ahHome = handicapCover(matrix, -0.5, 'home');
  const ahAway = handicapCover(matrix, -0.5, 'away');
  return [
    { leg: { kind: 'match-home' }, marketProb: clampProb(match.home), weight: 1 },
    { leg: { kind: 'match-draw' }, marketProb: clampProb(match.draw), weight: 1 },
    { leg: { kind: 'match-away' }, marketProb: clampProb(match.away), weight: 1 },
    { leg: { kind: 'over', line: 2.5 }, marketProb: clampProb(over25), weight: 1 },
    { leg: { kind: 'under', line: 2.5 }, marketProb: clampProb(1 - over25), weight: 1 },
    {
      leg: { kind: 'ah-home', handicap: -0.5 },
      marketProb: clampProb(ahHome.win + 0.5 * ahHome.push),
      weight: 1,
    },
    {
      leg: { kind: 'ah-away', handicap: -0.5 },
      marketProb: clampProb(ahAway.win + 0.5 * ahAway.push),
      weight: 1,
    },
  ];
};

describe('supremacyTotalToRates', () => {
  it('round-trips with the inverse mapping', () => {
    const rates = supremacyTotalToRates(0.6, 2.8);
    expect(rates.homeRate).toBeCloseTo(1.7, 12);
    expect(rates.awayRate).toBeCloseTo(1.1, 12);
    expect(rates.homeRate + rates.awayRate).toBeCloseTo(2.8, 12);
    expect(rates.homeRate - rates.awayRate).toBeCloseTo(0.6, 12);
  });

  it('floors both rates at a small positive value when supremacy approaches total', () => {
    const rates = supremacyTotalToRates(3.0, 3.0);
    expect(rates.homeRate).toBeCloseTo(3.0, 12);
    expect(rates.awayRate).toBeGreaterThan(0);
  });
});

describe('matchResultProbs', () => {
  it('sums to 1', () => {
    const matrix = scorelineMatrix({ homeRate: 1.6, awayRate: 1.0, rho: -0.13, maxGoals: 10 });
    const match = matchResultProbs(matrix);
    expect(match.home + match.draw + match.away).toBeCloseTo(1, 10);
  });

  it('is symmetric (home == away) when the rates are equal', () => {
    const matrix = scorelineMatrix({ homeRate: 1.25, awayRate: 1.25, rho: -0.13, maxGoals: 10 });
    const match = matchResultProbs(matrix);
    expect(match.home).toBeCloseTo(match.away, 12);
  });

  it('raises the home probability as supremacy increases', () => {
    const low = matchResultProbs(
      scorelineMatrix({ ...supremacyTotalToRates(0.2, 2.7), rho: -0.13, maxGoals: 10 }),
    );
    const high = matchResultProbs(
      scorelineMatrix({ ...supremacyTotalToRates(1.2, 2.7), rho: -0.13, maxGoals: 10 }),
    );
    expect(high.home).toBeGreaterThan(low.home);
    expect(high.away).toBeLessThan(low.away);
  });
});

describe('overProb', () => {
  it('matches the closed-form Poisson total at rho 0', () => {
    const homeRate = 1.55;
    const awayRate = 1.15;
    const matrix = scorelineMatrix({ homeRate, awayRate, rho: 0, maxGoals: 12 });
    const totalRate = homeRate + awayRate;
    const totalMasses = poissonPmf(totalRate, 12);
    // P(over 2.5) = P(total >= 3) = 1 - P(0) - P(1) - P(2) under independent Poisson.
    const expectedOver = 1 - (totalMasses[0] ?? 0) - (totalMasses[1] ?? 0) - (totalMasses[2] ?? 0);
    expect(overProb(matrix, 2.5)).toBeCloseTo(expectedOver, 6);
  });

  it('is monotone decreasing in the line', () => {
    const matrix = scorelineMatrix({ homeRate: 1.5, awayRate: 1.2, rho: -0.13, maxGoals: 10 });
    expect(overProb(matrix, 1.5)).toBeGreaterThan(overProb(matrix, 2.5));
    expect(overProb(matrix, 2.5)).toBeGreaterThan(overProb(matrix, 3.5));
  });
});

describe('handicapCover', () => {
  const matrix = scorelineMatrix({ homeRate: 1.7, awayRate: 1.0, rho: -0.13, maxGoals: 10 });
  const match = matchResultProbs(matrix);

  it('home -0.5 equals the home win probability (no push at a half line)', () => {
    const cover = handicapCover(matrix, -0.5, 'home');
    expect(cover.push).toBe(0);
    expect(cover.win).toBeCloseTo(match.home, 12);
  });

  it('home +0.5 equals home win plus draw', () => {
    const cover = handicapCover(matrix, 0.5, 'home');
    expect(cover.win).toBeCloseTo(match.home + match.draw, 12);
  });

  it('the two sides of a half line partition the probability', () => {
    const home = handicapCover(matrix, -0.5, 'home');
    const away = handicapCover(matrix, 0.5, 'away');
    expect(home.win + away.win).toBeCloseTo(1, 12);
  });
});

describe('fitGoalsModel', () => {
  it('recovers the planted (supremacy, total) from an exact surface', () => {
    const plantedSupremacy = 0.37;
    const plantedTotal = 2.73;
    const observed = exactSurface(
      plantedSupremacy,
      plantedTotal,
      DEFAULT_GOALS_MODEL_CONFIG.rho,
      DEFAULT_GOALS_MODEL_CONFIG.maxGoals,
    );
    const result = fitGoalsModel(observed, DEFAULT_GOALS_MODEL_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Math.abs(result.value.supremacy - plantedSupremacy)).toBeLessThan(0.05);
      expect(Math.abs(result.value.total - plantedTotal)).toBeLessThan(0.05);
      expect(result.value.cost).toBeLessThan(1e-3);
      expect(result.value.matchResult.home + result.value.matchResult.draw + result.value.matchResult.away).toBeCloseTo(1, 6);
    }
  });

  it('is deterministic: the same surface fits to the same parameters twice', () => {
    const observed = exactSurface(-0.8, 3.1, DEFAULT_GOALS_MODEL_CONFIG.rho, DEFAULT_GOALS_MODEL_CONFIG.maxGoals);
    const first = fitGoalsModel(observed, DEFAULT_GOALS_MODEL_CONFIG);
    const second = fitGoalsModel(observed, DEFAULT_GOALS_MODEL_CONFIG);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.supremacy).toBe(second.value.supremacy);
      expect(first.value.total).toBe(second.value.total);
    }
  });

  it('a prior pulls an under-constrained fit toward the anchor', () => {
    const observed = exactSurface(0.0, 2.6, DEFAULT_GOALS_MODEL_CONFIG.rho, DEFAULT_GOALS_MODEL_CONFIG.maxGoals);
    const withPrior: GoalsModelConfig = {
      ...DEFAULT_GOALS_MODEL_CONFIG,
      prior: { supremacy: 2.0, total: 2.6, weight: 50 },
    };
    const baseline = fitGoalsModel(observed, DEFAULT_GOALS_MODEL_CONFIG);
    const pulled = fitGoalsModel(observed, withPrior);
    expect(baseline.ok && pulled.ok).toBe(true);
    if (baseline.ok && pulled.ok) {
      // A heavy supremacy prior at +2.0 drags the fitted supremacy above the data-only fit.
      expect(pulled.value.supremacy).toBeGreaterThan(baseline.value.supremacy);
    }
  });

  it('rejects a surface with fewer than three legs', () => {
    const result = fitGoalsModel(
      [
        { leg: { kind: 'match-home' }, marketProb: clampProb(0.5), weight: 1 },
        { leg: { kind: 'match-away' }, marketProb: clampProb(0.3), weight: 1 },
      ],
      DEFAULT_GOALS_MODEL_CONFIG,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('insufficient-legs');
    }
  });

  it('rejects a malformed config', () => {
    const observed = exactSurface(0.2, 2.6, DEFAULT_GOALS_MODEL_CONFIG.rho, DEFAULT_GOALS_MODEL_CONFIG.maxGoals);
    const result = fitGoalsModel(observed, { ...DEFAULT_GOALS_MODEL_CONFIG, refineShrink: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-config');
    }
  });
});

describe('legEdges', () => {
  it('reports near-zero edges on an exactly consistent surface', () => {
    const observed = exactSurface(0.4, 2.7, DEFAULT_GOALS_MODEL_CONFIG.rho, DEFAULT_GOALS_MODEL_CONFIG.maxGoals);
    const result = fitGoalsModel(observed, DEFAULT_GOALS_MODEL_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const edge of legEdges(result.value, observed)) {
        expect(Math.abs(edge.edge)).toBeLessThan(0.01);
      }
    }
  });

  it('flags the lagging leg when one market is priced longer than the surface implies', () => {
    const observed = exactSurface(0.4, 2.7, DEFAULT_GOALS_MODEL_CONFIG.rho, DEFAULT_GOALS_MODEL_CONFIG.maxGoals);
    // Underprice the home leg: the market implies a lower home probability (longer odds) than
    // the joint cross-market fit, so legEdges should surface home as the most-deviant value.
    const homeIndex = observed.findIndex((observation) => observation.leg.kind === 'match-home');
    const homeBaseline = observed[homeIndex];
    if (homeBaseline === undefined) {
      throw new Error('home leg missing from the test surface');
    }
    const perturbed: ObservedLeg[] = observed.map((observation, index) =>
      index === homeIndex
        ? { ...observation, marketProb: clampProb(homeBaseline.marketProb - 0.06) }
        : observation,
    );
    const result = fitGoalsModel(perturbed, DEFAULT_GOALS_MODEL_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const edges = legEdges(result.value, perturbed);
      const ranked = [...edges].sort((left, right) => right.edge - left.edge);
      expect(ranked[0]?.leg.kind).toBe('match-home');
      expect(ranked[0]?.edge).toBeGreaterThan(0);
    }
  });
});
