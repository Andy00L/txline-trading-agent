import type { Brand, DecimalOddsMilli, Prob } from '../units.js';

/**
 * The outcomes of a 1X2 (match result) market. "other" covers any price label we
 * do not map to home/draw/away. sourceRef: docs/BUILD_PLAN.md (core/domain).
 */
export type Outcome = 'home' | 'draw' | 'away' | 'other';

/** The three settle-able outcomes of a 1X2 market, in canonical order. */
export const OUTCOMES_1X2: readonly Outcome[] = ['home', 'draw', 'away'];

/**
 * A single offered price for one outcome of a market. decimalOddsMilli is the
 * offered decimal odds times 1000; impliedPct is the feed-provided implied
 * probability (TxLINE Pct), or null when the feed reports NA.
 */
export type OddsLine = {
  readonly outcome: Outcome;
  readonly decimalOddsMilli: DecimalOddsMilli;
  readonly impliedPct: Prob | null;
};

/**
 * Identifies a unique market line across the feed, built from the fields that
 * separate one market from another on a fixture.
 * sourceRef: docs/BUILD_PLAN.md MarketKey = `${fixtureId}:${superOddsType}:${marketPeriod}:${marketParameters}`.
 */
export type MarketKey = Brand<string, 'MarketKey'>;

export const marketKey = (parts: {
  readonly fixtureId: number;
  readonly superOddsType: string;
  readonly marketPeriod: string;
  readonly marketParameters: string;
}): MarketKey =>
  `${parts.fixtureId}:${parts.superOddsType}:${parts.marketPeriod}:${parts.marketParameters}` as MarketKey;

/**
 * The TxLINE SuperOddsType for the 1X2 (match result) market, confirmed from a live odds
 * payload 2026-06-26 (O2). Handicap and over/under markets reuse the part1/part2 labels,
 * so outcome mapping must be gated on this type or they would be mis-assigned to
 * home/away. sourceRef: docs/research/M0-recon-findings.md (O2).
 */
export const SUPER_ODDS_TYPE_1X2 = '1X2_PARTICIPANT_RESULT';

/**
 * Map a 1X2 PriceNames label to an Outcome. Confirmed against a live odds payload
 * 2026-06-26 (O2): the labels are part1/draw/part2 (participant 1, draw, participant 2);
 * part1 is the home side because participant1IsHome is true on the sampled World Cup
 * fixtures. Older 1/X/2 forms are kept for robustness; unknown labels map to "other".
 * Call this only for SUPER_ODDS_TYPE_1X2 markets. sourceRef: docs/research/M0-recon-findings.md.
 */
const OUTCOME_BY_LABEL = new Map<string, Outcome>([
  ['part1', 'home'],
  ['part2', 'away'],
  ['1', 'home'],
  ['x', 'draw'],
  ['2', 'away'],
  ['home', 'home'],
  ['draw', 'draw'],
  ['away', 'away'],
  ['h', 'home'],
  ['d', 'draw'],
  ['a', 'away'],
]);

export const mapOutcomeLabel = (label: string): Outcome =>
  OUTCOME_BY_LABEL.get(label.trim().toLowerCase()) ?? 'other';
