/**
 * Independent World Football Elo ratings and a market-decorrelation stake overlay for the
 * cross-market strategy.
 *
 * The rating is deliberately NOT used as a forecast meant to beat the de-margined consensus.
 * A standalone Elo loses to bookmaker odds out-of-sample for soccer (Hvattum and Arntzen 2010,
 * Int. J. Forecasting 26(3):460-470; Wunderlich and Memmert 2018, PLoS ONE 13(6):e0198668), and
 * an independent model that is correlated with the book is unprofitable however accurate it is
 * (Hubacek, Sourek and Zelezny 2019, Int. J. Forecasting 35(2):783-796). The de-margined
 * consensus already embeds the public rating signal, so blending the rating into the price, or
 * gating trades on raw agreement with it, either double-counts or only discards sample.
 *
 * The defensible use, implemented here, acts only on the rating's RESIDUAL after orthogonalizing
 * against the consensus, as a bounded confidence weight on stake: never a hard gate, and never
 * inside the cross-market fit (which stays market-pure). The Elo update constants are frozen at
 * the published World Football Elo values (eloratings.net method), not tuned on the agent's own
 * sample, which is the overfitting defense. sourceRef: docs/research/quant-methods.md;
 * docs/DECISIONS.md (Elo as a decorrelated size overlay, not a fit prior or a gate); Hubacek
 * et al. (2019) for the decorrelation result.
 */
import { clampProb, type Prob } from '../units.js';
import { DEFAULT_MAX_GOALS, scorelineMatrix } from './poisson.js';
import { matchResultProbs, supremacyTotalToRates, type MatchResultProbs } from './surface.js';

/**
 * Frozen World Football Elo update constants (eloratings.net method): rating divisor 400, home
 * advantage 100 Elo applied only at a non-neutral venue, K = 60 for World Cup finals matches, and
 * an initial rating of 1500 for an unseen team. The goal-difference multiplier is applied per
 * match. These are imported from the published method, not fit on the agent's sample, so the
 * overlay cannot overfit the handful of bets it modulates. sourceRef: World Football Elo method;
 * the World Cup K tier.
 */
export type EloConfig = {
  readonly divisor: number;
  readonly homeAdvantage: number;
  readonly k: number;
  readonly initialRating: number;
};

export const DEFAULT_ELO_CONFIG: EloConfig = {
  divisor: 400,
  homeAdvantage: 100,
  k: 60,
  initialRating: 1500,
};

/**
 * Expected score for the home side (a win counts 1, a draw 0.5) under Elo: the logistic of the
 * rating difference, with the home-advantage term added only at a non-neutral venue. World Cup
 * matches are played at neutral grounds, so the term is dropped there. sourceRef: World Football
 * Elo expected-result formula.
 */
export const eloExpectedScore = (
  ratingHome: number,
  ratingAway: number,
  neutral: boolean,
  config: EloConfig,
): number => {
  const advantage = neutral ? 0 : config.homeAdvantage;
  const difference = ratingHome + advantage - ratingAway;
  return 1 / (1 + 10 ** (-difference / config.divisor));
};

/**
 * World Football Elo goal-difference multiplier: 1 for a draw or one-goal margin, 1.5 for two,
 * and (11 + margin) / 8 for three or more, so a decisive result moves the ratings further.
 * sourceRef: eloratings.net (the goal-difference index).
 */
const goalDifferenceMultiplier = (margin: number): number => {
  const absolute = Math.abs(margin);
  if (absolute <= 1) {
    return 1;
  }
  if (absolute === 2) {
    return 1.5;
  }
  return (11 + absolute) / 8;
};

/**
 * A finalized match used to update ratings, in participant space (participant 1 is the nominal
 * home side; neutral true drops the home-advantage term, as at a World Cup).
 */
export type EloMatch = {
  readonly homeTeam: number;
  readonly awayTeam: number;
  readonly homeGoals: number;
  readonly awayGoals: number;
  readonly neutral: boolean;
};

/**
 * Apply one finalized match to a rating table, returning a NEW table (the input is not mutated,
 * so a caller can keep a per-timestamp history and evaluate strictly walk-forward). A team not
 * yet seen starts at the initial rating. The update is zero-sum: the home side gains exactly what
 * the away side loses. sourceRef: World Football Elo update rule.
 */
export const applyEloMatch = (
  ratings: ReadonlyMap<number, number>,
  match: EloMatch,
  config: EloConfig,
): Map<number, number> => {
  const ratingHome = ratings.get(match.homeTeam) ?? config.initialRating;
  const ratingAway = ratings.get(match.awayTeam) ?? config.initialRating;
  const expected = eloExpectedScore(ratingHome, ratingAway, match.neutral, config);
  const actual =
    match.homeGoals > match.awayGoals ? 1 : match.homeGoals === match.awayGoals ? 0.5 : 0;
  const multiplier = goalDifferenceMultiplier(match.homeGoals - match.awayGoals);
  const delta = config.k * multiplier * (actual - expected);
  const next = new Map(ratings);
  next.set(match.homeTeam, ratingHome + delta);
  next.set(match.awayTeam, ratingAway - delta);
  return next;
};

/**
 * Configuration for mapping an Elo rating difference to a 1X2 distribution. The mapping holds
 * total goals at a fixed World Cup baseline, so it stays INDEPENDENT of the market's implied
 * total (which is what makes the rating's residual against the market meaningful), and reuses the
 * same Dixon-Coles dependence as the cross-market model, then solves for the supremacy that
 * reproduces the Elo expected score. sourceRef: docs/research/quant-methods.md.
 */
export type EloProbConfig = {
  /** Fixed total-goals baseline; recent World Cups average about 2.65 goals per match. */
  readonly totalBaseline: number;
  /** Dixon-Coles low-score dependence, matching the cross-market model. */
  readonly rho: number;
  readonly maxGoals: number;
  readonly supremacyMin: number;
  readonly supremacyMax: number;
  /** Bisection steps used to solve supremacy from the expected score; deterministic. */
  readonly solverIterations: number;
};

export const DEFAULT_ELO_PROB_CONFIG: EloProbConfig = {
  totalBaseline: 2.65,
  rho: -0.13,
  maxGoals: DEFAULT_MAX_GOALS,
  supremacyMin: -5,
  supremacyMax: 5,
  solverIterations: 40,
};

/** The home expected score (home win plus half the draw) implied by a supremacy at the fixed
 * total baseline, under the shared scoreline model. Monotonic increasing in supremacy. */
const homeExpectedScoreAtSupremacy = (supremacy: number, config: EloProbConfig): number => {
  const rates = supremacyTotalToRates(supremacy, config.totalBaseline);
  const matrix = scorelineMatrix({
    homeRate: rates.homeRate,
    awayRate: rates.awayRate,
    rho: config.rho,
    maxGoals: config.maxGoals,
  });
  const probs = matchResultProbs(matrix);
  return probs.home + 0.5 * probs.draw;
};

/**
 * Solve for the supremacy whose scoreline reproduces a target home expected score. The expected
 * score is monotonic increasing in supremacy, so a fixed-step bisection over the supremacy bounds
 * is deterministic and converges; the same target always yields the same supremacy.
 */
const solveSupremacyForExpectedScore = (expected: number, config: EloProbConfig): number => {
  const target = clampProb(expected);
  let low = config.supremacyMin;
  let high = config.supremacyMax;
  for (let step = 0; step < config.solverIterations; step += 1) {
    const mid = (low + high) / 2;
    if (homeExpectedScoreAtSupremacy(mid, config) < target) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
};

/**
 * The independent Elo-implied 1X2 distribution: map the rating difference to an expected score,
 * solve for the matching supremacy at the fixed total baseline, and read off the scoreline's 1X2
 * split. The draw is modeled consistently with the rest of the strategy, and the result is
 * independent of the market price by construction (no market input enters).
 */
export const eloMatchProbs = (
  ratingHome: number,
  ratingAway: number,
  neutral: boolean,
  config: EloConfig,
  probConfig: EloProbConfig,
): MatchResultProbs => {
  const expected = eloExpectedScore(ratingHome, ratingAway, neutral, config);
  const supremacy = solveSupremacyForExpectedScore(expected, probConfig);
  const rates = supremacyTotalToRates(supremacy, probConfig.totalBaseline);
  const matrix = scorelineMatrix({
    homeRate: rates.homeRate,
    awayRate: rates.awayRate,
    rho: probConfig.rho,
    maxGoals: probConfig.maxGoals,
  });
  return matchResultProbs(matrix);
};

/** The bounded stake overlay derived from the rating's residual against the market price. */
export type DecorrelationConfig = {
  /** Logit-space deadband; a residual smaller than this leaves the stake unchanged (the rating
   * is treated as silent, deferring fully to the cross-market signal). */
  readonly deadband: number;
  /** Upward multiplier slope per unit of corroborating residual beyond the deadband. */
  readonly scale: number;
  /** Cap on the upward multiplier when the rating corroborates the back. */
  readonly maxMultiplier: number;
  /** Multiplier when the rating contradicts the back (its residual points the other way). */
  readonly contradictMultiplier: number;
};

/**
 * Default overlay: a deadband of 0.12 in logit space (about three percentage points near even
 * money), a modest upward slope capped at 1.25x on corroboration, and a 0.5x cut on
 * contradiction. These bound how far an independent rating can move a stake the cross-market fit
 * has already justified; the rating never sets the stake on its own. sourceRef:
 * docs/research/quant-methods.md (decorrelated residual as a bounded size weight).
 */
export const DEFAULT_DECORRELATION_CONFIG: DecorrelationConfig = {
  deadband: 0.12,
  scale: 0.5,
  maxMultiplier: 1.25,
  contradictMultiplier: 0.5,
};

const LOGIT_EPSILON = 1e-9;

/** Logit with the argument clamped just inside (0, 1) so a boundary probability stays finite. */
const logit = (prob: number): number => {
  const clamped = Math.min(1 - LOGIT_EPSILON, Math.max(LOGIT_EPSILON, prob));
  return Math.log(clamped / (1 - clamped));
};

/**
 * The bounded stake multiplier for backing a leg the cross-market fit prices longer than the
 * market, given the independent rating's probability for the same leg. The residual
 * r = logit(ratingProb) - logit(marketProb) is the rating's view orthogonal to the market it is
 * compared against. Because the cross-market signal only ever backs a leg whose fair value
 * exceeds the market price, a positive residual (the rating agrees the leg is underpriced)
 * corroborates and scales the stake up to the cap; a residual inside the deadband leaves it
 * unchanged; a negative residual (the rating thinks the leg is overpriced) contradicts and cuts
 * the stake. It never returns 0, so the cross-market signal stays the primary edge and the rating
 * only modulates. sourceRef: Hubacek et al. (2019) decorrelation; docs/research/quant-methods.md.
 */
export const decorrelationMultiplier = (
  ratingProb: Prob,
  marketProb: Prob,
  config: DecorrelationConfig,
): number => {
  const residual = logit(ratingProb) - logit(marketProb);
  if (residual > config.deadband) {
    return Math.min(config.maxMultiplier, 1 + config.scale * (residual - config.deadband));
  }
  if (residual < -config.deadband) {
    return config.contradictMultiplier;
  }
  return 1;
};

/**
 * Configuration for the market-decorrelation stake overlay, assembled at the composition root and
 * passed to the pipeline. The optional seed is pre-tournament ratings by participant id; unseeded
 * teams begin at the Elo initial rating and the table evolves strictly walk-forward from finalized
 * results. neutral true (the World Cup default, played at neutral grounds) drops the
 * home-advantage term. When this config is absent the pipeline runs without any overlay.
 */
export type EloOverlayConfig = {
  readonly elo: EloConfig;
  readonly prob: EloProbConfig;
  readonly decorrelation: DecorrelationConfig;
  readonly seed?: ReadonlyMap<number, number>;
  readonly neutral: boolean;
};

export const DEFAULT_ELO_OVERLAY_CONFIG: EloOverlayConfig = {
  elo: DEFAULT_ELO_CONFIG,
  prob: DEFAULT_ELO_PROB_CONFIG,
  decorrelation: DEFAULT_DECORRELATION_CONFIG,
  neutral: true,
};
