import type { MarketKey, MarketKind, MarketPeriodKind, OddsLine } from './market.js';

/**
 * Normalized domain events. txline maps the raw zod-parsed API payloads into these
 * cleaned, branded shapes; the strategy and risk code consume only these, so the
 * same types flow whether the source is live SSE or replay.
 */

/** A normalized odds update for one market on a fixture at a point in time. */
export type OddsUpdate = {
  readonly fixtureId: number;
  readonly messageId: string; // keys the odds Merkle proof
  readonly tsMs: number;
  readonly bookmakerId: number;
  readonly superOddsType: string;
  readonly inRunning: boolean;
  readonly marketKey: MarketKey;
  /** The classified market kind (1X2 / Over-Under / Asian-Handicap / other), so the
   * cross-market model can group the surface for a fixture. */
  readonly marketKind: MarketKind;
  /** The total-goals or handicap line for Over/Under and Asian-Handicap markets; null for 1X2. */
  readonly line: number | null;
  /** Full game or first half; the strategy trades full-game markets only. */
  readonly period: MarketPeriodKind;
  readonly lines: readonly OddsLine[];
};

/** A normalized score update, keyed by (fixtureId, seq). Home and away goals are
 * derived from the full-game stat keys (1 and 2) using participant1IsHome, or null
 * when those stats are absent. */
export type ScoreUpdate = {
  readonly fixtureId: number;
  readonly seq: number;
  readonly tsMs: number;
  readonly gameState: string;
  readonly participant1IsHome: boolean;
  /** Scheduled kickoff in ms, or null when the record omits it. Drives the cross-market
   * time-to-kickoff entry gate. */
  readonly startTimeMs: number | null;
  readonly homeGoals: number | null;
  readonly awayGoals: number | null;
  readonly stats: ReadonlyMap<number, number>;
};

/** A normalized fixture record. */
export type FixtureUpdate = {
  readonly fixtureId: number;
  readonly tsMs: number;
  readonly startTimeMs: number;
  readonly competition: string;
  readonly competitionId: number;
  readonly participant1: string;
  readonly participant2: string;
  readonly participant1IsHome: boolean;
};
