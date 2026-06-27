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
  /** The raw price label from the feed (PriceNames), normalized to lower case: "part1",
   * "draw", "part2", "over", "under". It carries the side for Over/Under and Asian-Handicap
   * markets, where outcome stays "other"; the cross-market model reads it to place each line. */
  readonly label: string;
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

/**
 * The kind of market a SuperOddsType denotes. The free World Cup tier serves three per
 * fixture: 1X2 match result, Over/Under total goals, and Asian Handicap on goals.
 * sourceRef: market-taxonomy probe 2026-06-27 (live odds feed: 1X2_PARTICIPANT_RESULT,
 * OVERUNDER_PARTICIPANT_GOALS, ASIANHANDICAP_PARTICIPANT_GOALS).
 */
export type MarketKind = '1x2' | 'over-under' | 'asian-handicap' | 'other';

/**
 * The period a market settles over: the full game (MarketPeriod null or empty) or the
 * first half (MarketPeriod "half=1"); only those two values occur on the feed.
 * sourceRef: market-taxonomy probe 2026-06-27, docs/research/M0-recon-findings.md O2.
 */
export type MarketPeriodKind = 'full-game' | 'first-half' | 'other';

/** SuperOddsType for the Over/Under total-goals market. PriceNames ["over","under"],
 * MarketParameters "line=X". sourceRef: market-taxonomy probe 2026-06-27. */
export const SUPER_ODDS_TYPE_OVER_UNDER = 'OVERUNDER_PARTICIPANT_GOALS';

/** SuperOddsType for the Asian-Handicap goals market. PriceNames ["part1","part2"],
 * MarketParameters "line=X". sourceRef: market-taxonomy probe 2026-06-27. */
export const SUPER_ODDS_TYPE_ASIAN_HANDICAP = 'ASIANHANDICAP_PARTICIPANT_GOALS';

/**
 * Classify a SuperOddsType into a MarketKind. Unknown types are "other" and are ignored by
 * the strategy. sourceRef: market-taxonomy probe 2026-06-27.
 */
export const classifyMarketKind = (superOddsType: string): MarketKind => {
  switch (superOddsType) {
    case SUPER_ODDS_TYPE_1X2:
      return '1x2';
    case SUPER_ODDS_TYPE_OVER_UNDER:
      return 'over-under';
    case SUPER_ODDS_TYPE_ASIAN_HANDICAP:
      return 'asian-handicap';
    default:
      return 'other';
  }
};

/**
 * Classify a MarketPeriod string. The feed uses null or empty for the full match and
 * "half=1" for the first half; anything else is "other" and is not traded as a full-game
 * market. sourceRef: market-taxonomy probe 2026-06-27 (only those two values occur).
 */
export const classifyMarketPeriod = (marketPeriod: string | null): MarketPeriodKind => {
  if (marketPeriod === null || marketPeriod === '') {
    return 'full-game';
  }
  if (marketPeriod === 'half=1') {
    return 'first-half';
  }
  return 'other';
};

// The total-goals or handicap line lives in MarketParameters as "line=X" (for example
// "line=2.5", "line=-0.25"). sourceRef: market-taxonomy probe 2026-06-27.
const MARKET_LINE_PATTERN = /^line=(-?\d+(?:\.\d+)?)$/;

/**
 * Parse the numeric line from a MarketParameters value, or null when it is absent or
 * malformed (1X2 markets carry no line). sourceRef: market-taxonomy probe 2026-06-27.
 */
export const parseMarketLine = (marketParameters: string | null): number | null => {
  if (marketParameters === null) {
    return null;
  }
  const match = MARKET_LINE_PATTERN.exec(marketParameters.trim());
  const captured = match?.[1];
  if (captured === undefined) {
    return null;
  }
  const value = Number(captured);
  return Number.isFinite(value) ? value : null;
};
