/**
 * Poisson goal-model primitives for the cross-market surface: a numerically stable
 * Poisson probability mass and a Dixon-Coles-corrected scoreline matrix
 * P(home = i, away = j).
 *
 * sourceRef: docs/research/quant-methods.md (goals model). Maher (1982) "Modelling
 * association football scores" (independent Poisson); Dixon and Coles (1997) "Modelling
 * Association Football Scores and Inefficiencies in the Football Betting Market", JRSS C
 * 46(2):265-280 (the low-score tau correction). The tau adjustment multiplies only the
 * four lowest scorelines and reduces to independent Poisson at rho = 0.
 */

/** Maximum goals per side in the truncated scoreline matrix. P(goals > 10) is below
 * 1e-4 for realistic football scoring rates, so a 0..10 grid captures essentially all
 * mass; the matrix is renormalized to sum to 1 to absorb the dropped tail. */
export const DEFAULT_MAX_GOALS = 10;

export type ScorelineParams = {
  /** Home scoring rate lambda (expected home goals), strictly positive. */
  readonly homeRate: number;
  /** Away scoring rate mu (expected away goals), strictly positive. */
  readonly awayRate: number;
  /** Dixon-Coles low-score dependence rho; 0 reduces to independent Poisson. */
  readonly rho: number;
  /** Truncation: goals run 0..maxGoals inclusive on each side. */
  readonly maxGoals: number;
};

/**
 * Poisson probability masses P(X = goals) for goals = 0..maxGoals at the given rate,
 * by the stable forward recurrence p_0 = e^-rate, p_k = p_{k-1} * rate / k (no
 * factorials, no overflow). Caller guarantees rate >= 0 and maxGoals >= 0.
 */
export const poissonPmf = (rate: number, maxGoals: number): number[] => {
  const masses = new Array<number>(maxGoals + 1).fill(0);
  let mass = Math.exp(-rate);
  masses[0] = mass;
  for (let goals = 1; goals <= maxGoals; goals += 1) {
    mass = (mass * rate) / goals;
    masses[goals] = mass;
  }
  return masses;
};

/**
 * Dixon-Coles tau adjustment on the four lowest scorelines. With rho slightly negative
 * it lifts the 0-0 and 1-1 cells and lowers 1-0 and 0-1, the dependence real football
 * scores show that independent Poisson misses. sourceRef: Dixon and Coles (1997), the
 * tau(0,0)/tau(0,1)/tau(1,0)/tau(1,1) form.
 */
const dixonColesTau = (
  homeGoals: number,
  awayGoals: number,
  homeRate: number,
  awayRate: number,
  rho: number,
): number => {
  if (homeGoals === 0 && awayGoals === 0) {
    return 1 - homeRate * awayRate * rho;
  }
  if (homeGoals === 0 && awayGoals === 1) {
    return 1 + homeRate * rho;
  }
  if (homeGoals === 1 && awayGoals === 0) {
    return 1 + awayRate * rho;
  }
  if (homeGoals === 1 && awayGoals === 1) {
    return 1 - rho;
  }
  return 1;
};

/**
 * The scoreline probability matrix where matrix[homeGoals][awayGoals] = P(home scores
 * homeGoals AND away scores awayGoals), Dixon-Coles-corrected and renormalized to sum
 * to 1. A tau that drives a low cell negative under an extreme rho is clamped to 0
 * before renormalization, so every entry is a valid probability.
 */
export const scorelineMatrix = (params: ScorelineParams): number[][] => {
  const homeMasses = poissonPmf(params.homeRate, params.maxGoals);
  const awayMasses = poissonPmf(params.awayRate, params.maxGoals);
  const matrix: number[][] = [];
  let total = 0;
  for (let homeGoals = 0; homeGoals <= params.maxGoals; homeGoals += 1) {
    const homeMass = homeMasses[homeGoals] ?? 0;
    const row = new Array<number>(params.maxGoals + 1).fill(0);
    for (let awayGoals = 0; awayGoals <= params.maxGoals; awayGoals += 1) {
      const awayMass = awayMasses[awayGoals] ?? 0;
      const corrected =
        dixonColesTau(homeGoals, awayGoals, params.homeRate, params.awayRate, params.rho) *
        homeMass *
        awayMass;
      const nonNegative = corrected > 0 ? corrected : 0;
      row[awayGoals] = nonNegative;
      total += nonNegative;
    }
    matrix.push(row);
  }
  if (total > 0) {
    for (const row of matrix) {
      for (let awayGoals = 0; awayGoals < row.length; awayGoals += 1) {
        row[awayGoals] = (row[awayGoals] ?? 0) / total;
      }
    }
  }
  return matrix;
};
