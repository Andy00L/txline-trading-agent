import type { MarketKey } from '../domain/market.js';
import type { DecimalOddsMilli, MicroUsd, Prob } from '../units.js';

export type BreakerReason =
  | 'stale-feed'
  | 'root-mismatch'
  | 'outlier-odds'
  | 'bankroll-floor'
  | 'daily-drawdown'
  | 'exposure-cap'
  | 'max-concurrent';

export type RiskConfig = {
  /** Stop trading when bankroll reaches or drops below this. */
  readonly bankrollFloor: MicroUsd;
  /** Hard cap on a single order's stake; larger proposals are reduced. */
  readonly maxStakePerOrder: MicroUsd;
  /** Maximum simultaneously open positions. */
  readonly maxConcurrent: number;
  readonly totalExposureCap: MicroUsd;
  readonly perFixtureExposureCap: MicroUsd;
  readonly perMarketExposureCap: MicroUsd;
  /** A feed older than this (now - feedTs) is stale; block. */
  readonly staleFeedMs: number;
  /** Block when the offered implied probability deviates from consensus by more
   * than this many dispersion units (only when dispersion is known). */
  readonly outlierOddsZ: number;
  /** Block once the day's realized drawdown exceeds this. */
  readonly maxDailyDrawdown: MicroUsd;
};

export type RiskState = {
  readonly bankroll: MicroUsd;
  readonly dayStartBankroll: MicroUsd;
  readonly openCount: number;
  readonly totalExposure: MicroUsd;
  readonly exposureByFixture: ReadonlyMap<number, MicroUsd>;
  readonly exposureByMarket: ReadonlyMap<string, MicroUsd>;
  /** Latched breakers that block all trading until reset (e.g. root-mismatch). */
  readonly latched: readonly BreakerReason[];
};

/** Per-evaluation market context so the outlier check needs no IO. dispersion is 0
 * when only the consensus line is available (single book). */
export type RiskContext = {
  readonly consensusFairProb: Prob;
  readonly dispersion: number;
};

export type EvaluateInput = {
  readonly proposedStake: MicroUsd;
  readonly offeredOddsMilli: DecimalOddsMilli;
  readonly fixtureId: number;
  readonly marketKey: MarketKey;
  readonly nowMs: number;
  readonly feedTsMs: number;
  readonly context: RiskContext;
};

export type RiskVerdict =
  | { readonly allowed: true; readonly stake: MicroUsd }
  | { readonly allowed: false; readonly reason: BreakerReason };
