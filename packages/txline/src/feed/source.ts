import { ok, type Result } from '@txline-agent/core';
import type { TxlineClient } from '../http/client.js';
import type { TxlineError } from '../http/types.js';
import type { OddsPayload } from '../schemas/odds.js';
import type { ScoresPayload } from '../schemas/scores.js';

/** A single historical 5-minute interval coordinate. */
export type IntervalCoord = {
  readonly epochDay: number;
  readonly hourOfDay: number;
  readonly interval: number;
};

/** Source of raw payloads for replay, one interval at a time. Implemented over the
 * live /updates endpoints or over recorded in-memory fixtures. */
export interface ReplaySource {
  oddsInterval(coord: IntervalCoord): Promise<Result<readonly OddsPayload[], TxlineError>>;
  scoresInterval(coord: IntervalCoord): Promise<Result<readonly ScoresPayload[], TxlineError>>;
}

/** Replay from the live /updates endpoints via the REST client. */
export class ClientReplaySource implements ReplaySource {
  private readonly client: TxlineClient;

  constructor(client: TxlineClient) {
    this.client = client;
  }

  oddsInterval(coord: IntervalCoord): Promise<Result<readonly OddsPayload[], TxlineError>> {
    return this.client.getOddsUpdates(coord.epochDay, coord.hourOfDay, coord.interval);
  }

  scoresInterval(coord: IntervalCoord): Promise<Result<readonly ScoresPayload[], TxlineError>> {
    return this.client.getScoresUpdates(coord.epochDay, coord.hourOfDay, coord.interval);
  }
}

const keyOf = (coord: IntervalCoord): string =>
  `${coord.epochDay}:${coord.hourOfDay}:${coord.interval}`;

/** Replay from recorded in-memory payloads keyed by interval. Used by the backtest
 * and the determinism and identical-path tests; never touches the network. */
export class RecordedReplaySource implements ReplaySource {
  private readonly odds: ReadonlyMap<string, readonly OddsPayload[]>;
  private readonly scores: ReadonlyMap<string, readonly ScoresPayload[]>;

  constructor(
    odds: ReadonlyMap<string, readonly OddsPayload[]>,
    scores: ReadonlyMap<string, readonly ScoresPayload[]>,
  ) {
    this.odds = odds;
    this.scores = scores;
  }

  oddsInterval(coord: IntervalCoord): Promise<Result<readonly OddsPayload[], TxlineError>> {
    return Promise.resolve(ok(this.odds.get(keyOf(coord)) ?? []));
  }

  scoresInterval(coord: IntervalCoord): Promise<Result<readonly ScoresPayload[], TxlineError>> {
    return Promise.resolve(ok(this.scores.get(keyOf(coord)) ?? []));
  }
}
