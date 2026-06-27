import {
  type Feed,
  type FeedEvent,
  type FeedRunResult,
  type ManualClock,
  type OddsUpdate,
  type ScoreUpdate,
} from '@txline-agent/core';
import { mapOddsPayload } from '../map/odds.js';
import { mapScorePayload } from '../map/score.js';
import type { IntervalCoord, ReplaySource } from './source.js';
import { IdempotencyTracker } from './idempotency.js';

export type ReplayFeedDeps = {
  readonly source: ReplaySource;
  readonly clock: ManualClock;
  readonly intervals: readonly IntervalCoord[];
};

// Channel rank breaks ties at equal timestamps: odds before scores. Combined with
// the original fetch order this gives a total, reproducible ordering.
type PendingOdds = {
  readonly channelRank: 0;
  readonly tsMs: number;
  readonly order: number;
  readonly payload: OddsUpdate;
};
type PendingScore = {
  readonly channelRank: 1;
  readonly tsMs: number;
  readonly order: number;
  readonly payload: ScoreUpdate;
};
type Pending = PendingOdds | PendingScore;

/**
 * Replays a recorded or historical window through the one Feed interface. It fetches
 * each interval, maps raw payloads to domain events, sorts them into a single
 * deterministic order by (tsMs, channel, fetch order), advances the injected
 * ManualClock to each event's timestamp, and emits with source "replay". The same
 * input always produces a byte-identical event sequence.
 */
export class ReplayFeed implements Feed {
  private readonly deps: ReplayFeedDeps;
  private stopped = false;
  private result: FeedRunResult = { eventsEmitted: 0, gapsDetected: 0, reconnects: 0 };
  private resolveDone: (result: FeedRunResult) => void = () => {};
  private readonly donePromise: Promise<FeedRunResult>;

  constructor(deps: ReplayFeedDeps) {
    this.deps = deps;
    this.donePromise = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  async *events(): AsyncIterable<FeedEvent> {
    const pending: Pending[] = [];
    // Dedup by the same keys as the live feed (odds MessageId, scores fixtureId+seq), so a
    // recorded window containing a duplicate replays identically to live, preserving the
    // one-code-path guarantee for duplicate-containing inputs. sourceRef: feed/live.ts.
    const idempotency = new IdempotencyTracker();
    let order = 0;
    let gaps = 0;

    for (const coord of this.deps.intervals) {
      const oddsResult = await this.deps.source.oddsInterval(coord);
      if (oddsResult.ok) {
        for (const raw of oddsResult.value) {
          if (!idempotency.acceptOdds(raw.MessageId)) {
            continue;
          }
          const mapped = mapOddsPayload(raw);
          if (mapped.ok) {
            pending.push({ channelRank: 0, tsMs: mapped.value.tsMs, order, payload: mapped.value });
            order += 1;
          }
        }
      } else {
        gaps += 1;
      }

      const scoresResult = await this.deps.source.scoresInterval(coord);
      if (scoresResult.ok) {
        for (const raw of scoresResult.value) {
          if (!idempotency.acceptScore(raw.FixtureId, raw.Seq)) {
            continue;
          }
          const mapped = mapScorePayload(raw);
          if (mapped.ok) {
            pending.push({ channelRank: 1, tsMs: mapped.value.tsMs, order, payload: mapped.value });
            order += 1;
          }
        }
      } else {
        gaps += 1;
      }
    }

    pending.sort(
      (left, right) =>
        left.tsMs - right.tsMs ||
        left.channelRank - right.channelRank ||
        left.order - right.order,
    );

    let seq = 0;
    let emitted = 0;
    for (const item of pending) {
      if (this.stopped) {
        break;
      }
      this.deps.clock.setMs(item.tsMs);
      const receivedAtMs = this.deps.clock.nowMs();
      if (item.channelRank === 0) {
        yield {
          kind: 'odds',
          envelope: { source: 'replay', seq, receivedAtMs, payload: item.payload },
        };
      } else {
        yield {
          kind: 'score',
          envelope: { source: 'replay', seq, receivedAtMs, payload: item.payload },
        };
      }
      seq += 1;
      emitted += 1;
    }

    this.result = { eventsEmitted: emitted, gapsDetected: gaps, reconnects: 0 };
    this.resolveDone(this.result);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  done(): Promise<FeedRunResult> {
    return this.donePromise;
  }
}
