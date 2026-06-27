/**
 * Cross-market goals model over the full TxLINE odds surface (1X2 + Over/Under +
 * Asian Handicap on the same fixture). It fits one consistent scoreline distribution
 * to every observed market leg, then exposes per-leg fair probabilities. A leg whose
 * market price deviates from the joint fit is a cross-market relative-value signal: one
 * market stream lagging the others, which converges back (a structurally Closing-Line-
 * Value-positive entry rather than chasing a completed move).
 *
 * sourceRef: docs/research/quant-methods.md (goals model + cross-market relative value).
 * Maher (1982); Dixon and Coles (1997); Karlis and Ntzoufras (2003) for the scoreline
 * family. Kaunitz et al. (2017) "Beating the bookies with their own numbers"
 * (arXiv:1710.02824) for the "back the leg priced longer than the consensus fair value"
 * rule, with the consensus here taken from the joint cross-market fit rather than a
 * multi-book mean. The honest framing (a de-margined consensus cannot be out-forecast by
 * a model fitted to it; the edge is cross-market consistency, slow-leg timing, and the
 * independent prior) is recorded in docs/DECISIONS.md.
 */
import { ok, err, type Result } from '../result.js';
import { clampProb, type Prob } from '../units.js';
import type { QuantError } from './error.js';
import { DEFAULT_MAX_GOALS, scorelineMatrix, type ScorelineParams } from './poisson.js';

/** Smallest scoring rate the model will use; keeps both Poisson rates strictly positive
 * even when the supremacy approaches the total. */
const MIN_RATE = 0.01;

/** A scoreline probability matrix, matrix[homeGoals][awayGoals]. Read-only at the boundary. */
export type ScoreMatrix = readonly (readonly number[])[];

/**
 * Convert the trading-desk (supremacy, total) basis to Poisson scoring rates:
 * homeRate = (total + supremacy) / 2, awayRate = (total - supremacy) / 2, each floored
 * at MIN_RATE so the Poisson masses stay defined. Supremacy = home minus away expected
 * goals; total = home plus away. sourceRef: docs/research/quant-methods.md (supremacy-
 * total reparametrization of the Poisson rates).
 */
export const supremacyTotalToRates = (
  supremacy: number,
  total: number,
): { readonly homeRate: number; readonly awayRate: number } => ({
  homeRate: Math.max(MIN_RATE, (total + supremacy) / 2),
  awayRate: Math.max(MIN_RATE, (total - supremacy) / 2),
});

export type MatchResultProbs = { readonly home: number; readonly draw: number; readonly away: number };

/** The 1X2 (match-result) probabilities by summing the scoreline matrix: home when
 * homeGoals > awayGoals, draw on the diagonal, away below it. */
export const matchResultProbs = (matrix: ScoreMatrix): MatchResultProbs => {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let homeGoals = 0; homeGoals < matrix.length; homeGoals += 1) {
    const row = matrix[homeGoals];
    if (row === undefined) {
      continue;
    }
    for (let awayGoals = 0; awayGoals < row.length; awayGoals += 1) {
      const cell = row[awayGoals] ?? 0;
      if (homeGoals > awayGoals) {
        home += cell;
      } else if (homeGoals === awayGoals) {
        draw += cell;
      } else {
        away += cell;
      }
    }
  }
  return { home, draw, away };
};

/** P(total goals > line). At a half line (e.g. 2.5) there is no push and
 * P(under) = 1 - P(over). sourceRef: derive Over/Under from the total of the matrix. */
export const overProb = (matrix: ScoreMatrix, line: number): number => {
  let over = 0;
  for (let homeGoals = 0; homeGoals < matrix.length; homeGoals += 1) {
    const row = matrix[homeGoals];
    if (row === undefined) {
      continue;
    }
    for (let awayGoals = 0; awayGoals < row.length; awayGoals += 1) {
      if (homeGoals + awayGoals > line) {
        over += row[awayGoals] ?? 0;
      }
    }
  }
  return over;
};

export type HandicapSide = 'home' | 'away';

/**
 * Asian-handicap cover probabilities for one side and a handicap added to that side's
 * goal count: the side wins when its handicapped goal difference is positive, pushes when
 * it is exactly 0 (only possible at an integer effective line). At a half line the push
 * is 0. sourceRef: Constantinou (2020) arXiv:2003.09384 (AH settlement).
 */
export const handicapCover = (
  matrix: ScoreMatrix,
  handicap: number,
  side: HandicapSide,
): { readonly win: number; readonly push: number } => {
  let win = 0;
  let push = 0;
  for (let homeGoals = 0; homeGoals < matrix.length; homeGoals += 1) {
    const row = matrix[homeGoals];
    if (row === undefined) {
      continue;
    }
    for (let awayGoals = 0; awayGoals < row.length; awayGoals += 1) {
      const difference = side === 'home' ? homeGoals - awayGoals : awayGoals - homeGoals;
      const margin = difference + handicap;
      const cell = row[awayGoals] ?? 0;
      if (margin > 0) {
        win += cell;
      } else if (margin === 0) {
        push += cell;
      }
    }
  }
  return { win, push };
};

/**
 * One leg of the observable surface. The handicap on an AH leg is added to that leg's own
 * side (ah-home handicap -0.5 wins when home wins by 1+); over/under carry the total-goals
 * line. The cross-market fit treats all legs as views of one scoreline distribution.
 */
export type SurfaceLeg =
  | { readonly kind: 'match-home' }
  | { readonly kind: 'match-draw' }
  | { readonly kind: 'match-away' }
  | { readonly kind: 'over'; readonly line: number }
  | { readonly kind: 'under'; readonly line: number }
  | { readonly kind: 'ah-home'; readonly handicap: number }
  | { readonly kind: 'ah-away'; readonly handicap: number };

export type ObservedLeg = {
  readonly leg: SurfaceLeg;
  /** The de-vigged market probability for this leg (de-vig both sides of a two-way market
   * identically before constructing it). */
  readonly marketProb: Prob;
  /** Relative weight in the fit objective; a thin or stale leg can be down-weighted. */
  readonly weight: number;
};

/** The model-implied probability of one leg under a scoreline matrix. An AH leg counts a
 * push as half (stake returned), the break-even probability for a price with a push. */
const legModelProb = (matrix: ScoreMatrix, match: MatchResultProbs, leg: SurfaceLeg): number => {
  switch (leg.kind) {
    case 'match-home':
      return match.home;
    case 'match-draw':
      return match.draw;
    case 'match-away':
      return match.away;
    case 'over':
      return overProb(matrix, leg.line);
    case 'under':
      return 1 - overProb(matrix, leg.line);
    case 'ah-home': {
      const cover = handicapCover(matrix, leg.handicap, 'home');
      return cover.win + 0.5 * cover.push;
    }
    case 'ah-away': {
      const cover = handicapCover(matrix, leg.handicap, 'away');
      return cover.win + 0.5 * cover.push;
    }
  }
};

export type GoalsModelBounds = {
  readonly supremacyMin: number;
  readonly supremacyMax: number;
  readonly totalMin: number;
  readonly totalMax: number;
};

export type GoalsModelPrior = {
  /** Independent supremacy anchor (e.g. mapped from a World Football Elo gap). */
  readonly supremacy: number;
  /** Independent total-goals anchor (e.g. a tournament-stage baseline). */
  readonly total: number;
  /** Penalty weight pulling the fit toward (supremacy, total); 0 disables the prior. */
  readonly weight: number;
};

export type GoalsModelConfig = {
  /** Fixed Dixon-Coles dependence; held constant because it is under-identified from a
   * handful of legs at one timestamp. sourceRef: R1 research (hold rho at ~ -0.13). */
  readonly rho: number;
  readonly maxGoals: number;
  readonly bounds: GoalsModelBounds;
  /** Grid resolution per axis in the coarse pass. */
  readonly coarseSteps: number;
  /** Grid half-resolution per axis in each refine pass (steps run -refineSteps..refineSteps). */
  readonly refineSteps: number;
  /** Number of zoom rounds after the coarse pass. */
  readonly refineRounds: number;
  /** Window shrink factor per refine round, in (0, 1). */
  readonly refineShrink: number;
  readonly prior?: GoalsModelPrior;
};

/** Default fit configuration: rho fixed at the literature prior, a 24x24 coarse grid then
 * four shrinking refine rounds. Deterministic (no RNG); the same surface always fits to the
 * same (supremacy, total). */
export const DEFAULT_GOALS_MODEL_CONFIG: GoalsModelConfig = {
  rho: -0.13,
  maxGoals: DEFAULT_MAX_GOALS,
  bounds: { supremacyMin: -5, supremacyMax: 5, totalMin: 0.2, totalMax: 7 },
  coarseSteps: 24,
  refineSteps: 6,
  refineRounds: 4,
  refineShrink: 0.4,
};

export type GoalsFit = {
  readonly supremacy: number;
  readonly total: number;
  readonly homeRate: number;
  readonly awayRate: number;
  readonly rho: number;
  /** Weighted sum-of-squares residual at the chosen (supremacy, total); lower is a tighter
   * cross-market fit. */
  readonly cost: number;
  readonly matrix: ScoreMatrix;
  readonly matchResult: { readonly home: Prob; readonly draw: Prob; readonly away: Prob };
};

const clampToRange = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

const matrixParamsFor = (supremacy: number, total: number, config: GoalsModelConfig): ScorelineParams => {
  const rates = supremacyTotalToRates(supremacy, total);
  return { homeRate: rates.homeRate, awayRate: rates.awayRate, rho: config.rho, maxGoals: config.maxGoals };
};

/**
 * Fit one scoreline distribution to the observed odds surface by minimizing the weighted
 * squared error between each leg's market probability and the model probability, plus an
 * optional penalty toward an independent prior. The search is a deterministic coarse grid
 * over (supremacy, total) followed by shrinking refine rounds, so the same surface always
 * yields the same fit. Errors are values: a malformed config or fewer than three legs (too
 * few to over-determine the two parameters and produce a relative-value residual) returns a
 * distinct QuantError. sourceRef: docs/research/quant-methods.md (cross-market fit; >= 3
 * independent legs needed for a non-trivial residual).
 */
export const fitGoalsModel = (
  observed: readonly ObservedLeg[],
  config: GoalsModelConfig,
): Result<GoalsFit, QuantError> => {
  if (!(Number.isInteger(config.maxGoals) && config.maxGoals >= 1)) {
    return err({ kind: 'invalid-config', detail: `maxGoals=${config.maxGoals} must be a positive integer` });
  }
  if (!(Number.isInteger(config.coarseSteps) && config.coarseSteps >= 1)) {
    return err({ kind: 'invalid-config', detail: `coarseSteps=${config.coarseSteps} must be a positive integer` });
  }
  if (!(Number.isInteger(config.refineSteps) && config.refineSteps >= 1)) {
    return err({ kind: 'invalid-config', detail: `refineSteps=${config.refineSteps} must be a positive integer` });
  }
  if (!(Number.isInteger(config.refineRounds) && config.refineRounds >= 0)) {
    return err({ kind: 'invalid-config', detail: `refineRounds=${config.refineRounds} must be a non-negative integer` });
  }
  if (!(config.refineShrink > 0 && config.refineShrink < 1)) {
    return err({ kind: 'invalid-config', detail: `refineShrink=${config.refineShrink} not in (0,1)` });
  }
  if (!(config.bounds.supremacyMin < config.bounds.supremacyMax && config.bounds.totalMin < config.bounds.totalMax)) {
    return err({ kind: 'invalid-config', detail: 'bounds must satisfy min < max on each axis' });
  }
  if (config.bounds.totalMin <= 0) {
    return err({ kind: 'invalid-config', detail: `totalMin=${config.bounds.totalMin} must be > 0` });
  }
  if (observed.length < 3) {
    return err({ kind: 'insufficient-legs', detail: `${observed.length} legs, need >= 3 to over-determine (supremacy, total)` });
  }
  for (const observation of observed) {
    if (!(observation.weight >= 0 && Number.isFinite(observation.weight))) {
      return err({ kind: 'invalid-config', detail: `leg weight ${observation.weight} must be finite and >= 0` });
    }
  }

  const evaluateCost = (supremacy: number, total: number): number => {
    const matrix = scorelineMatrix(matrixParamsFor(supremacy, total, config));
    const match = matchResultProbs(matrix);
    let cost = 0;
    for (const observation of observed) {
      const modelProb = legModelProb(matrix, match, observation.leg);
      const residual = modelProb - observation.marketProb;
      cost += observation.weight * residual * residual;
    }
    if (config.prior !== undefined) {
      const supremacyGap = supremacy - config.prior.supremacy;
      const totalGap = total - config.prior.total;
      cost += config.prior.weight * (supremacyGap * supremacyGap + totalGap * totalGap);
    }
    return cost;
  };

  const { supremacyMin, supremacyMax, totalMin, totalMax } = config.bounds;
  let best: { supremacy: number; total: number; cost: number } = {
    supremacy: (supremacyMin + supremacyMax) / 2,
    total: (totalMin + totalMax) / 2,
    cost: Number.POSITIVE_INFINITY,
  };

  for (let supremacyStep = 0; supremacyStep <= config.coarseSteps; supremacyStep += 1) {
    const supremacy = supremacyMin + ((supremacyMax - supremacyMin) * supremacyStep) / config.coarseSteps;
    for (let totalStep = 0; totalStep <= config.coarseSteps; totalStep += 1) {
      const total = totalMin + ((totalMax - totalMin) * totalStep) / config.coarseSteps;
      const cost = evaluateCost(supremacy, total);
      if (cost < best.cost) {
        best = { supremacy, total, cost };
      }
    }
  }

  let windowSupremacy = (supremacyMax - supremacyMin) / config.coarseSteps;
  let windowTotal = (totalMax - totalMin) / config.coarseSteps;
  for (let round = 0; round < config.refineRounds; round += 1) {
    const centerSupremacy = best.supremacy;
    const centerTotal = best.total;
    for (let supremacyStep = -config.refineSteps; supremacyStep <= config.refineSteps; supremacyStep += 1) {
      const supremacy = clampToRange(
        centerSupremacy + (windowSupremacy * supremacyStep) / config.refineSteps,
        supremacyMin,
        supremacyMax,
      );
      for (let totalStep = -config.refineSteps; totalStep <= config.refineSteps; totalStep += 1) {
        const total = clampToRange(
          centerTotal + (windowTotal * totalStep) / config.refineSteps,
          totalMin,
          totalMax,
        );
        const cost = evaluateCost(supremacy, total);
        if (cost < best.cost) {
          best = { supremacy, total, cost };
        }
      }
    }
    windowSupremacy *= config.refineShrink;
    windowTotal *= config.refineShrink;
  }

  if (!Number.isFinite(best.cost)) {
    return err({ kind: 'no-convergence', detail: 'goals-model fit found no finite cost' });
  }

  const rates = supremacyTotalToRates(best.supremacy, best.total);
  const matrix = scorelineMatrix({
    homeRate: rates.homeRate,
    awayRate: rates.awayRate,
    rho: config.rho,
    maxGoals: config.maxGoals,
  });
  const match = matchResultProbs(matrix);
  return ok({
    supremacy: best.supremacy,
    total: best.total,
    homeRate: rates.homeRate,
    awayRate: rates.awayRate,
    rho: config.rho,
    cost: best.cost,
    matrix,
    matchResult: {
      home: clampProb(match.home),
      draw: clampProb(match.draw),
      away: clampProb(match.away),
    },
  });
};

export type LegEdge = {
  readonly leg: SurfaceLeg;
  readonly modelProb: Prob;
  readonly marketProb: Prob;
  /** Probability-space mispricing: model fair probability minus the market-implied one.
   * Positive means the market price is longer than the joint cross-market fit says it
   * should be, so backing this leg carries cross-market relative value. */
  readonly edge: number;
};

/** Per-leg relative value: the model fair probability against each observed market
 * probability under the fitted scoreline. The leg with the largest positive edge is the
 * one the rest of the surface disagrees with most (the lagging leg to back). */
export const legEdges = (fit: GoalsFit, observed: readonly ObservedLeg[]): LegEdge[] => {
  const match: MatchResultProbs = {
    home: fit.matchResult.home,
    draw: fit.matchResult.draw,
    away: fit.matchResult.away,
  };
  return observed.map((observation) => {
    const modelProb = legModelProb(fit.matrix, match, observation.leg);
    return {
      leg: observation.leg,
      modelProb: clampProb(modelProb),
      marketProb: observation.marketProb,
      edge: modelProb - observation.marketProb,
    };
  });
};
