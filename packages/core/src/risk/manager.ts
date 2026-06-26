import type { MarketKey } from '../domain/market.js';
import { decimalOddsMilliToProb, microUsdSaturating, type MicroUsd } from '../units.js';
import type {
  BreakerReason,
  EvaluateInput,
  RiskConfig,
  RiskState,
  RiskVerdict,
} from './types.js';

const minBigint = (first: bigint, ...rest: readonly bigint[]): bigint => {
  let smallest = first;
  for (const value of rest) {
    if (value < smallest) {
      smallest = value;
    }
  }
  return smallest;
};

const addToMap = <TKey>(
  map: ReadonlyMap<TKey, MicroUsd>,
  key: TKey,
  delta: bigint,
): ReadonlyMap<TKey, MicroUsd> => {
  const next = new Map(map);
  next.set(key, microUsdSaturating((map.get(key) ?? 0n) + delta));
  return next;
};

/** A fresh risk state for a starting bankroll. */
export const createRiskState = (startingBankroll: MicroUsd): RiskState => ({
  bankroll: startingBankroll,
  dayStartBankroll: startingBankroll,
  openCount: 0,
  totalExposure: microUsdSaturating(0n),
  exposureByFixture: new Map<number, MicroUsd>(),
  exposureByMarket: new Map<string, MicroUsd>(),
  latched: [],
});

/**
 * Decide whether a proposed order may proceed, and at what stake. Pure: all time
 * and market context are passed in. Latched breakers block everything; otherwise it
 * checks bankroll floor, daily drawdown, feed staleness, outlier odds, the
 * concurrency limit, and the exposure caps, reducing the stake to fit the caps and
 * the per-order maximum rather than rejecting outright where a smaller stake works.
 */
export const evaluate = (
  state: RiskState,
  input: EvaluateInput,
  config: RiskConfig,
): RiskVerdict => {
  const firstLatched = state.latched[0];
  if (firstLatched !== undefined) {
    return { allowed: false, reason: firstLatched };
  }
  if (state.bankroll <= config.bankrollFloor) {
    return { allowed: false, reason: 'bankroll-floor' };
  }
  if (state.dayStartBankroll - state.bankroll > config.maxDailyDrawdown) {
    return { allowed: false, reason: 'daily-drawdown' };
  }
  if (input.nowMs - input.feedTsMs > config.staleFeedMs) {
    return { allowed: false, reason: 'stale-feed' };
  }
  const offeredProb = decimalOddsMilliToProb(input.offeredOddsMilli);
  if (
    input.context.dispersion > 0 &&
    Math.abs(offeredProb - input.context.consensusFairProb) >
      config.outlierOddsZ * input.context.dispersion
  ) {
    return { allowed: false, reason: 'outlier-odds' };
  }
  if (state.openCount >= config.maxConcurrent) {
    return { allowed: false, reason: 'max-concurrent' };
  }

  let stake: bigint = input.proposedStake;
  if (stake > config.maxStakePerOrder) {
    stake = config.maxStakePerOrder;
  }
  const roomTotal = config.totalExposureCap - state.totalExposure;
  const roomFixture =
    config.perFixtureExposureCap - (state.exposureByFixture.get(input.fixtureId) ?? 0n);
  const roomMarket =
    config.perMarketExposureCap - (state.exposureByMarket.get(input.marketKey) ?? 0n);
  const room = minBigint(roomTotal, roomFixture, roomMarket);
  if (room <= 0n) {
    return { allowed: false, reason: 'exposure-cap' };
  }
  if (stake > room) {
    stake = room;
  }
  if (stake <= 0n) {
    return { allowed: false, reason: 'exposure-cap' };
  }
  return { allowed: true, stake: microUsdSaturating(stake) };
};

/** Reserve exposure for a newly committed order. */
export const onCommit = (
  state: RiskState,
  input: { readonly stake: MicroUsd; readonly fixtureId: number; readonly marketKey: MarketKey },
): RiskState => ({
  ...state,
  openCount: state.openCount + 1,
  totalExposure: microUsdSaturating(state.totalExposure + input.stake),
  exposureByFixture: addToMap(state.exposureByFixture, input.fixtureId, input.stake),
  exposureByMarket: addToMap(state.exposureByMarket, input.marketKey, input.stake),
});

/** Realize PnL and release exposure for a settled order. pnl is signed micro-USD. */
export const onSettlement = (
  state: RiskState,
  input: {
    readonly stake: MicroUsd;
    readonly pnl: bigint;
    readonly fixtureId: number;
    readonly marketKey: MarketKey;
  },
): RiskState => ({
  ...state,
  bankroll: microUsdSaturating(state.bankroll + input.pnl),
  openCount: Math.max(0, state.openCount - 1),
  totalExposure: microUsdSaturating(state.totalExposure - input.stake),
  exposureByFixture: addToMap(state.exposureByFixture, input.fixtureId, -input.stake),
  exposureByMarket: addToMap(state.exposureByMarket, input.marketKey, -input.stake),
});

/** Latch a breaker (e.g. a verification root-mismatch) so trading stops until reset. */
export const onAnomaly = (state: RiskState, reason: BreakerReason): RiskState =>
  state.latched.includes(reason) ? state : { ...state, latched: [...state.latched, reason] };

/** Clear latched breakers and reset the daily-drawdown baseline to the current bankroll. */
export const reset = (state: RiskState): RiskState => ({
  ...state,
  latched: [],
  dayStartBankroll: state.bankroll,
});
