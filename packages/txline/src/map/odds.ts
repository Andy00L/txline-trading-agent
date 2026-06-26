import {
  decimalOddsMilli,
  err,
  mapOutcomeLabel,
  marketKey,
  ok,
  pctStringToProb,
  SUPER_ODDS_TYPE_1X2,
  type OddsLine,
  type OddsUpdate,
  type Prob,
  type Result,
} from '@txline-agent/core';
import type { OddsPayload } from '../schemas/odds.js';
import type { MapError } from './error.js';

/**
 * Map a raw odds payload to a normalized OddsUpdate. PriceNames, Prices, and Pct
 * are parallel arrays; outcomes come from the labels, odds from the integer prices,
 * and implied probabilities from Pct (null for NA). A price that is not valid
 * decimal odds or a malformed Pct fails the whole update with a distinct error.
 */
export const mapOddsPayload = (raw: OddsPayload): Result<OddsUpdate, MapError> => {
  const priceNames = raw.PriceNames ?? [];
  const prices = raw.Prices ?? [];
  const percentages = raw.Pct ?? [];

  if (priceNames.length !== prices.length) {
    return err({
      kind: 'odds-array-mismatch',
      detail: `PriceNames=${priceNames.length} Prices=${prices.length}`,
    });
  }

  // Only the 1X2 result market maps labels to home/draw/away; handicap and over/under
  // reuse part1/part2 for unrelated sides, so their outcomes stay "other" and the
  // 1X2 strategy ignores them. sourceRef: domain/market.ts SUPER_ODDS_TYPE_1X2 (O2).
  const isResult1X2 = raw.SuperOddsType === SUPER_ODDS_TYPE_1X2;

  const lines: OddsLine[] = [];
  for (let index = 0; index < priceNames.length; index += 1) {
    const label = priceNames[index];
    const priceMilli = prices[index];
    if (label === undefined || priceMilli === undefined) {
      continue;
    }
    const odds = decimalOddsMilli(priceMilli);
    if (!odds.ok) {
      return err({
        kind: 'invalid-odds',
        detail: `price[${index}]=${priceMilli}: ${odds.error.detail}`,
      });
    }
    let impliedPct: Prob | null = null;
    const percentage = percentages[index];
    if (percentage !== undefined) {
      const parsed = pctStringToProb(percentage);
      if (!parsed.ok) {
        return err({ kind: 'malformed-pct', detail: `pct[${index}]=${percentage}` });
      }
      impliedPct = parsed.value;
    }
    lines.push({
      outcome: isResult1X2 ? mapOutcomeLabel(label) : 'other',
      decimalOddsMilli: odds.value,
      impliedPct,
    });
  }

  const key = marketKey({
    fixtureId: raw.FixtureId,
    superOddsType: raw.SuperOddsType,
    marketPeriod: raw.MarketPeriod ?? '',
    marketParameters: raw.MarketParameters ?? '',
  });

  return ok({
    fixtureId: raw.FixtureId,
    messageId: raw.MessageId,
    tsMs: raw.Ts,
    bookmakerId: raw.BookmakerId,
    superOddsType: raw.SuperOddsType,
    inRunning: raw.InRunning,
    marketKey: key,
    lines,
  });
};
