import { describe, expect, it } from 'vitest';
import { matchResultProbs } from './surface.js';
import { poissonPmf, scorelineMatrix } from './poisson.js';

const sumMatrix = (matrix: readonly (readonly number[])[]): number =>
  matrix.reduce((rowSum, row) => rowSum + row.reduce((cellSum, cell) => cellSum + cell, 0), 0);

describe('poissonPmf', () => {
  it('matches the closed-form masses for rate 1', () => {
    const masses = poissonPmf(1, 5);
    // P(X=k) = e^-1 / k!  ->  0.36788, 0.36788, 0.18394, 0.06131, 0.01533, 0.00307
    expect(masses[0]).toBeCloseTo(Math.exp(-1), 12);
    expect(masses[1]).toBeCloseTo(Math.exp(-1), 12);
    expect(masses[2]).toBeCloseTo(Math.exp(-1) / 2, 12);
    expect(masses[3]).toBeCloseTo(Math.exp(-1) / 6, 12);
  });

  it('sums to ~1 over a wide support', () => {
    const masses = poissonPmf(2.4, 40);
    expect(masses.reduce((sum, mass) => sum + mass, 0)).toBeCloseTo(1, 10);
  });

  it('collapses to a point mass at rate 0', () => {
    const masses = poissonPmf(0, 4);
    expect(masses[0]).toBe(1);
    expect(masses[1]).toBe(0);
    expect(masses[4]).toBe(0);
  });
});

describe('scorelineMatrix', () => {
  it('sums to 1 after renormalization', () => {
    const matrix = scorelineMatrix({ homeRate: 1.55, awayRate: 1.15, rho: -0.13, maxGoals: 10 });
    expect(sumMatrix(matrix)).toBeCloseTo(1, 10);
  });

  it('reduces to the independent Poisson product at rho 0', () => {
    const homeRate = 1.4;
    const awayRate = 1.0;
    const matrix = scorelineMatrix({ homeRate, awayRate, rho: 0, maxGoals: 12 });
    const homeMasses = poissonPmf(homeRate, 12);
    const awayMasses = poissonPmf(awayRate, 12);
    // At rho 0 each cell is the product of the marginals (renormalization is ~1 over a wide grid).
    expect(matrix[2]?.[1]).toBeCloseTo((homeMasses[2] ?? 0) * (awayMasses[1] ?? 0), 6);
  });

  it('is symmetric when the two rates are equal', () => {
    const matrix = scorelineMatrix({ homeRate: 1.3, awayRate: 1.3, rho: -0.13, maxGoals: 10 });
    expect(matrix[0]?.[2]).toBeCloseTo(matrix[2]?.[0] ?? Number.NaN, 12);
    expect(matrix[1]?.[3]).toBeCloseTo(matrix[3]?.[1] ?? Number.NaN, 12);
  });

  it('lifts draw probability versus independent Poisson when rho is negative', () => {
    const independent = matchResultProbs(
      scorelineMatrix({ homeRate: 1.3, awayRate: 1.3, rho: 0, maxGoals: 10 }),
    );
    const dependent = matchResultProbs(
      scorelineMatrix({ homeRate: 1.3, awayRate: 1.3, rho: -0.13, maxGoals: 10 }),
    );
    // Dixon-Coles with rho < 0 moves mass onto 0-0 and 1-1, raising the draw probability.
    expect(dependent.draw).toBeGreaterThan(independent.draw);
  });
});
