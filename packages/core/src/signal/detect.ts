import type { MarketKey, Outcome } from '../domain/market.js';
import { expectedValue } from '../quant/ev.js';
import { decimalOddsMilliToProb, type DecimalOddsMilli, type Prob } from '../units.js';
import type { Signal } from './types.js';

export type DivergenceConfig = {
  /** Minimum EV per unit stake to act on (e.g. 0.02 = 2 percent). */
  readonly minEdge: number;
  /** Ignore outcomes whose fair probability is outside [minProb, maxProb]. */
  readonly minProb: number;
  readonly maxProb: number;
};

export type DivergenceInput = {
  readonly fixtureId: number;
  readonly marketKey: MarketKey;
  readonly outcome: Outcome;
  readonly tsMs: number;
  /** Consensus fair probability for the outcome (from de-vig). */
  readonly fairProb: Prob;
  /** The odds on offer that we would take (another book, or an in-play line). */
  readonly offeredOddsMilli: DecimalOddsMilli;
};

/**
 * Divergence: an offered line whose implied probability sits below the consensus
 * fair probability by enough to clear minEdge. Returns a signal or null.
 * sourceRef: docs/DECISIONS.md (consensus-divergence archetype).
 */
export const detectDivergence = (
  input: DivergenceInput,
  config: DivergenceConfig,
): Signal | null => {
  if (input.fairProb < config.minProb || input.fairProb > config.maxProb) {
    return null;
  }
  const edge = expectedValue(input.fairProb, input.offeredOddsMilli);
  if (edge < config.minEdge) {
    return null;
  }
  const offeredProb = decimalOddsMilliToProb(input.offeredOddsMilli);
  return {
    kind: 'divergence',
    fixtureId: input.fixtureId,
    marketKey: input.marketKey,
    outcome: input.outcome,
    tsMs: input.tsMs,
    fairProb: input.fairProb,
    offeredOddsMilli: input.offeredOddsMilli,
    edge,
    strength: input.fairProb - offeredProb,
  };
};

export type SteamConfig = {
  /** Look-back window for the move, in milliseconds. */
  readonly windowMs: number;
  /** Minimum upward move in fair probability to call steam (e.g. 0.03). */
  readonly minProbMove: number;
  /** Minimum EV per unit stake at the current offered odds. */
  readonly minEdge: number;
};

export type ProbObservation = { readonly tsMs: number; readonly fairProb: Prob };

export type SteamInput = {
  readonly fixtureId: number;
  readonly marketKey: MarketKey;
  readonly outcome: Outcome;
  readonly tsMs: number;
  /** Recent fair-probability observations for the outcome, oldest first. */
  readonly history: readonly ProbObservation[];
  readonly offeredOddsMilli: DecimalOddsMilli;
};

/**
 * Steam: a sharp recent upward move in the consensus fair probability for an
 * outcome (the line shortening). If the move within the window clears minProbMove
 * and the current offered odds still give minEdge, signal a back in the direction
 * of the move. We only act on upward moves; this strategy does not lay.
 * sourceRef: docs/DECISIONS.md (sharp-move / steam archetype).
 */
export const detectSteam = (input: SteamInput, config: SteamConfig): Signal | null => {
  const inWindow = input.history.filter(
    (observation) =>
      observation.tsMs <= input.tsMs && input.tsMs - observation.tsMs <= config.windowMs,
  );
  if (inWindow.length < 2) {
    return null;
  }
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  const move = last.fairProb - first.fairProb;
  if (move < config.minProbMove) {
    return null;
  }
  const edge = expectedValue(last.fairProb, input.offeredOddsMilli);
  if (edge < config.minEdge) {
    return null;
  }
  return {
    kind: 'steam',
    fixtureId: input.fixtureId,
    marketKey: input.marketKey,
    outcome: input.outcome,
    tsMs: input.tsMs,
    fairProb: last.fairProb,
    offeredOddsMilli: input.offeredOddsMilli,
    edge,
    strength: move,
  };
};
