import type { Decision } from '../domain/decision.js';
import type { Outcome } from '../domain/market.js';
import type { Prob } from '../units.js';

/**
 * The seam runPipeline writes its lifecycle events to. It is the one place live and
 * replay diverge: the backtest records these for metrics, while the M6 live agent
 * commits the hash and settles by CPI. Methods may be sync or async; the pipeline
 * awaits them, so a recording sink stays synchronous and an on-chain sink does IO.
 * sourceRef: docs/BUILD_PLAN.md (one code path for live and replay).
 */

export type CommittedPosition = {
  readonly index: number;
  readonly decision: Decision;
  readonly committedAtMs: number;
};

export type SettledPosition = {
  readonly index: number;
  readonly decision: Decision;
  /** The final 1X2 result derived from the attested score (home/draw/away). */
  readonly result: Outcome;
  readonly won: boolean;
  /** Signed realized PnL in micro-USD (profit on a win, -stake on a loss). */
  readonly pnl: bigint;
  readonly settledAtMs: number;
  /** The score (fixtureId, seq) the result was settled against. The on-chain sink fetches
   * the stat-validation proof for this exact seq, so settlement re-proves the same score
   * the pipeline used. */
  readonly settledSeq: number;
  /** The market (de-vigged 1X2 consensus) fair probability for the backed outcome at entry.
   * Closing Line Value compares this against closingFairProb, so it is the market line at
   * entry, not the model's fair probability (which decision.fairProb carries for calibration).
   * For a consensus-only signal the two coincide; for the cross-market signal they differ. */
  readonly entryConsensusProb: Prob;
  /** The last consensus fair probability for the backed outcome, the closing-line
   * input for Closing Line Value. */
  readonly closingFairProb: Prob;
  /** False when no consensus observation arrived after entry, so closingFairProb fell back
   * to the entry consensus and the Closing Line Value for this bet is unknown (the backtest
   * excludes it from CLV averages) rather than a true zero. */
  readonly closingFairProbKnown: boolean;
};

export interface PipelineSink {
  onCommit(position: CommittedPosition): void | Promise<void>;
  onSettle(position: SettledPosition): void | Promise<void>;
}
