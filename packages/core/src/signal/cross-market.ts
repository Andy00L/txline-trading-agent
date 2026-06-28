import { computeFairBook } from '../quant/devig.js';
import { fairProbOf, type DevigMethod } from '../domain/fairbook.js';
import { expectedValue } from '../quant/ev.js';
import type { QuantError } from '../quant/error.js';
import {
  fitGoalsModel,
  legEdges,
  type GoalsModelConfig,
  type LegEdge,
  type ObservedLeg,
  type SurfaceLeg,
} from '../quant/surface.js';
import { DEFAULT_GOALS_MODEL_CONFIG } from '../quant/surface.js';
import { OUTCOMES_1X2, type MarketKey, type Outcome } from '../domain/market.js';
import type { OddsLine } from '../domain/market.js';
import { clampProb, decimalOddsMilliToProb, type DecimalOddsMilli, type Prob } from '../units.js';
import { ok, type Result } from '../result.js';
import type { Signal } from './types.js';

/**
 * Cross-market relative-value detection over a fixture's full odds surface. It fits one
 * goals model jointly to the 1X2 and Over/Under markets, then backs the 1X2 outcome the
 * joint fit prices longer than the 1X2 line alone does. The model supplies an independent
 * fair probability (informed by the total-goals market), so the back is sized by a genuine
 * positive Kelly edge rather than chasing a completed move. sourceRef:
 * docs/research/quant-methods.md (cross-market relative value); Kaunitz et al. (2017).
 */

export type CrossMarketConfig = {
  /** Minimum probability-space mispricing (model fair minus 1X2 market fair) to act on. */
  readonly minEdge: number;
  /** Ignore outcomes whose model fair probability is outside [minProb, maxProb]. */
  readonly minProb: number;
  readonly maxProb: number;
  /** De-vig method for the 1X2 market (the favourite-longshot-aware Shin by default). */
  readonly devigMethod: DevigMethod;
  readonly model: GoalsModelConfig;
  /** Relative weight of the 1X2 family in the fit (split across its three legs). */
  readonly matchWeight: number;
  /** Relative weight of the Over/Under family in the fit (split across its lines). */
  readonly overUnderWeight: number;
  /** Minimum feed-time gap between cross-market fits for one fixture, in milliseconds. The fit
   * is the per-update cost, so this bounds it: a live feed can fit on every qualifying update,
   * while a backtest replaying a long window at once spaces the fits without changing the signal
   * (a mispricing persists across updates), keeping entry within one cadence of when it appears. */
  readonly minRefitMs: number;
  /** Earliest entry: do not commit unless kickoff is at least this many ms away, so a genuine
   * closing line still forms after entry (Closing Line Value needs a post-entry close). */
  readonly minLeadMs: number;
  /** Latest entry: do not commit more than this many ms before kickoff, so the strategy trades
   * the liquid near-kickoff market, not a thin far-out one (the root of false signals). The
   * pipeline only knows kickoff once the scores channel reports the fixture, which already
   * excludes far-future fixtures. sourceRef: R2 (condition on time-to-kickoff). */
  readonly maxLeadMs: number;
};

/** Default cross-market config: Shin de-vig, a 2pp minimum cross-market mispricing, balanced
 * 1X2 and Over/Under families, refit at most once a minute per fixture. sourceRef: R3 (Shin for
 * the longshot legs), R2 (size by edge, enter early). */
export const DEFAULT_CROSS_MARKET_CONFIG: CrossMarketConfig = {
  minEdge: 0.01,
  minProb: 0.05,
  maxProb: 0.95,
  devigMethod: 'shin',
  model: DEFAULT_GOALS_MODEL_CONFIG,
  matchWeight: 1,
  overUnderWeight: 1,
  minRefitMs: 60_000,
  minLeadMs: 300_000, // at least 5 minutes before kickoff
  maxLeadMs: 21_600_000, // at most 6 hours before kickoff
};

/** One Over/Under market on the surface: the total-goals line and its two priced lines. */
export type OverUnderMarket = { readonly line: number; readonly lines: readonly OddsLine[] };

/** A fixture's odds surface at one instant: the latest full-game 1X2 lines plus the latest
 * full-game Over/Under markets, one per total-goals line. */
export type CrossMarketSurface = {
  readonly fixtureId: number;
  /** The 1X2 market key, which the decision and on-chain commit route on. */
  readonly marketKey: MarketKey;
  readonly tsMs: number;
  readonly matchLines: readonly OddsLine[];
  readonly overUnder: readonly OverUnderMarket[];
};

const OUTCOME_BY_MATCH_LEG: ReadonlyMap<SurfaceLeg['kind'], Outcome> = new Map([
  ['match-home', 'home'],
  ['match-draw', 'draw'],
  ['match-away', 'away'],
]);

/** Find a priced line by its normalized label (e.g. "over", "part1"). */
const lineByLabel = (lines: readonly OddsLine[], label: string): OddsLine | undefined =>
  lines.find((line) => line.label === label);

/**
 * De-vig a two-way market (Over/Under) multiplicatively to the fair probability of the
 * "over" side: p_over = r_over / (r_over + r_under). At a near-de-margined two-way price the
 * favourite-longshot correction is negligible (Shin equals the additive method for n = 2),
 * so multiplicative normalization is sufficient. Returns null if either side is missing.
 */
const overFairProb = (lines: readonly OddsLine[]): Prob | null => {
  const over = lineByLabel(lines, 'over');
  const under = lineByLabel(lines, 'under');
  if (over === undefined || under === undefined) {
    return null;
  }
  const overImplied = decimalOddsMilliToProb(over.decimalOddsMilli);
  const underImplied = decimalOddsMilliToProb(under.decimalOddsMilli);
  const booksum = overImplied + underImplied;
  if (!(booksum > 0)) {
    return null;
  }
  return clampProb(overImplied / booksum);
};

type MatchFair = {
  readonly legs: readonly ObservedLeg[];
  readonly offeredByOutcome: ReadonlyMap<Outcome, DecimalOddsMilli>;
};

/** Build the three 1X2 match legs (de-vigged fair probabilities) and the offered odds per
 * outcome, or null if the 1X2 book cannot be de-vigged or a side is missing. */
const buildMatchLegs = (
  matchLines: readonly OddsLine[],
  config: CrossMarketConfig,
): MatchFair | null => {
  const fairBook = computeFairBook(matchLines, config.devigMethod);
  if (!fairBook.ok) {
    return null;
  }
  const offeredByOutcome = new Map<Outcome, DecimalOddsMilli>();
  for (const line of matchLines) {
    if (line.outcome !== 'other') {
      offeredByOutcome.set(line.outcome, line.decimalOddsMilli);
    }
  }
  const legWeight = config.matchWeight / OUTCOMES_1X2.length;
  const legs: ObservedLeg[] = [];
  for (const outcome of OUTCOMES_1X2) {
    const fairProb = fairProbOf(fairBook.value, outcome);
    if (fairProb === null || !offeredByOutcome.has(outcome)) {
      return null;
    }
    const kind: SurfaceLeg['kind'] =
      outcome === 'home' ? 'match-home' : outcome === 'draw' ? 'match-draw' : 'match-away';
    legs.push({ leg: { kind }, marketProb: fairProb, weight: legWeight });
  }
  return { legs, offeredByOutcome };
};

/** Build the Over/Under legs from the half-integer total-goals lines (no push), one "over"
 * leg per line, the family weight split across them. */
const buildOverUnderLegs = (
  overUnder: readonly OverUnderMarket[],
  config: CrossMarketConfig,
): ObservedLeg[] => {
  const halfLines = overUnder.filter(
    (market) => Number.isInteger(market.line * 2) && !Number.isInteger(market.line),
  );
  if (halfLines.length === 0) {
    return [];
  }
  const legWeight = config.overUnderWeight / halfLines.length;
  const legs: ObservedLeg[] = [];
  for (const market of halfLines) {
    const probOver = overFairProb(market.lines);
    if (probOver === null) {
      continue;
    }
    legs.push({ leg: { kind: 'over', line: market.line }, marketProb: probOver, weight: legWeight });
  }
  return legs;
};

/**
 * Detect a cross-market relative-value signal on a fixture's odds surface, or null when no
 * 1X2 leg is mispriced enough to act. Fits the goals model to the 1X2 + Over/Under legs, then
 * picks the 1X2 outcome whose model fair probability most exceeds its 1X2 market fair
 * probability (the lagging leg). Returns a distinct QuantError when the model fit fails.
 */
export const detectCrossMarketValue = (
  surface: CrossMarketSurface,
  config: CrossMarketConfig,
): Result<Signal | null, QuantError> => {
  const match = buildMatchLegs(surface.matchLines, config);
  if (match === null) {
    return ok(null);
  }
  const overUnderLegs = buildOverUnderLegs(surface.overUnder, config);
  if (overUnderLegs.length === 0) {
    // Without a second market the 1X2 fit is exactly determined and carries no residual, so
    // there is no cross-market signal to detect.
    return ok(null);
  }
  const legs: ObservedLeg[] = [...match.legs, ...overUnderLegs];
  const fit = fitGoalsModel(legs, config.model);
  if (!fit.ok) {
    return fit;
  }
  const edges = legEdges(fit.value, legs);

  let best: LegEdge | null = null;
  for (const edge of edges) {
    if (OUTCOME_BY_MATCH_LEG.has(edge.leg.kind) && (best === null || edge.edge > best.edge)) {
      best = edge;
    }
  }
  if (best === null) {
    return ok(null);
  }
  const outcome = OUTCOME_BY_MATCH_LEG.get(best.leg.kind);
  if (outcome === undefined) {
    return ok(null);
  }
  const modelFairProb = best.modelProb;
  if (best.edge < config.minEdge || modelFairProb < config.minProb || modelFairProb > config.maxProb) {
    return ok(null);
  }
  const offeredOddsMilli = match.offeredByOutcome.get(outcome);
  if (offeredOddsMilli === undefined) {
    return ok(null);
  }
  return ok({
    kind: 'cross-market',
    fixtureId: surface.fixtureId,
    marketKey: surface.marketKey,
    outcome,
    tsMs: surface.tsMs,
    fairProb: modelFairProb,
    offeredOddsMilli,
    edge: expectedValue(modelFairProb, offeredOddsMilli),
    strength: best.edge,
    // The market consensus for this leg, so the decorrelation overlay can measure the
    // independent rating's residual against the price the model is disagreeing with.
    marketProb: best.marketProb,
  });
};
