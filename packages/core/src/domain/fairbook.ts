import type { Prob } from '../units.js';
import type { Outcome } from './market.js';

/** De-vig method used to produce a fair book. sourceRef: docs/research/quant-methods.md. */
export type DevigMethod = 'multiplicative' | 'shin';

export type FairOutcome = {
  readonly outcome: Outcome;
  readonly fairProb: Prob;
};

/**
 * A de-vigged (fair) view of a market. fairProb values sum to 1. booksum is the
 * sum of the raw implied probabilities (1/odds); overround is booksum - 1; shinZ
 * is the recovered insider-trading fraction for the Shin method, or null.
 */
export type FairBook = {
  readonly method: DevigMethod;
  readonly outcomes: readonly FairOutcome[];
  readonly booksum: number;
  readonly overround: number;
  readonly shinZ: number | null;
};

/** Look up the fair probability of one outcome, or null if it is not in the book. */
export const fairProbOf = (book: FairBook, outcome: Outcome): Prob | null =>
  book.outcomes.find((entry) => entry.outcome === outcome)?.fairProb ?? null;
