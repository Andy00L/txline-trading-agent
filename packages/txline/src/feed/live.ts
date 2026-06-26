import { z } from 'zod';
import {
  type Clock,
  type Feed,
  type FeedEnvelope,
  type FeedEvent,
  type FeedRunResult,
  type FeedStatusKind,
  type GapInfo,
  type Heartbeat,
  type Prng,
} from '@txline-agent/core';
import { mapOddsPayload } from '../map/odds.js';
import { mapScorePayload } from '../map/score.js';
import { parseWith } from '../parse.js';
import { oddsPayloadSchema } from '../schemas/odds.js';
import { scoresPayloadSchema } from '../schemas/scores.js';
import { computeBackoffMs, DEFAULT_BACKOFF, type BackoffConfig } from '../http/backoff.js';
import type { TxlineClient } from '../http/client.js';
import { IdempotencyTracker } from './idempotency.js';
import type { SseFrame } from './sse-parse.js';
import type { IntervalCoord } from './source.js';

export type SseChannel = 'odds' | 'scores';
export type TaggedFrame = { readonly channel: SseChannel; readonly frame: SseFrame };

/** Opens an SSE connection and yields tagged frames until the stream ends (the
 * iterator completes) or fails (it throws). lastEventId resumes via Last-Event-ID. */
export interface SseConnector {
  connect(lastEventId: string | null): AsyncIterable<TaggedFrame>;
}

export type LiveSseFeedDeps = {
  readonly connector: SseConnector;
  readonly client: TxlineClient; // used to backfill the gap on reconnect
  readonly clock: Clock;
  readonly prng: Prng;
  readonly sleep: (ms: number) => Promise<void>;
  readonly backoff?: BackoffConfig;
  /** Stop after this many reconnect attempts. Default: unbounded (live). */
  readonly maxReconnects?: number;
  /** Intervals to re-fetch on reconnect to fill the gap. Default: none. */
  readonly backfillIntervals?: (lastTsMs: number) => readonly IntervalCoord[];
};

type RunState = {
  seq: number;
  lastEventId: string | null;
  lastTsMs: number;
  reconnects: number;
  gaps: number;
  attempt: number;
};

const heartbeatSchema = z.object({ Ts: z.number() });

const parseHeartbeatTs = (data: string | undefined): number | null => {
  if (data === undefined) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = heartbeatSchema.safeParse(json);
  return parsed.success ? parsed.data.Ts : null;
};

/**
 * Live feed over Server-Sent Events. Frames are parsed and mapped to domain events,
 * deduplicated by the same idempotency keys as replay, and emitted with source
 * "live-sse". A dropped connection triggers exponential backoff (full jitter, seeded
 * PRNG), a Last-Event-ID resume, and a REST backfill of the gap; idempotency makes
 * the overlap safe. The SseConnector and Clock are injected so the logic is testable
 * and deterministic. sourceRef: docs/BUILD_PLAN.md (LiveSseFeed, resilience).
 */
export class LiveSseFeed implements Feed {
  private readonly deps: LiveSseFeedDeps;
  private readonly backoff: BackoffConfig;
  private readonly maxReconnects: number;
  private stopped = false;
  private result: FeedRunResult = { eventsEmitted: 0, gapsDetected: 0, reconnects: 0 };
  private resolveDone: (result: FeedRunResult) => void = () => {};
  private readonly donePromise: Promise<FeedRunResult>;

  constructor(deps: LiveSseFeedDeps) {
    this.deps = deps;
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.maxReconnects = deps.maxReconnects ?? Number.POSITIVE_INFINITY;
    this.donePromise = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  async *events(): AsyncIterable<FeedEvent> {
    const idempotency = new IdempotencyTracker();
    const state: RunState = {
      seq: 0,
      lastEventId: null,
      lastTsMs: 0,
      reconnects: 0,
      gaps: 0,
      attempt: 0,
    };

    yield this.statusEvent('connected', 'initial connection', state);

    for (;;) {
      if (this.stopped) {
        break;
      }
      let failed = false;
      try {
        for await (const tagged of this.deps.connector.connect(state.lastEventId)) {
          if (this.stopped) {
            break;
          }
          yield* this.ingest(tagged, state, idempotency);
        }
      } catch {
        // The connector adapts a throwing transport boundary; a dropped connection
        // becomes a reconnect rather than a thrown error out of the feed.
        failed = true;
      }
      if (this.stopped) {
        break;
      }
      if (state.reconnects >= this.maxReconnects) {
        yield this.statusEvent('stopped', `reached max reconnects ${this.maxReconnects}`, state);
        break;
      }
      state.reconnects += 1;
      yield this.statusEvent('reconnecting', failed ? 'connection error' : 'stream ended', state);
      yield* this.backfill(state, idempotency);
      await this.deps.sleep(computeBackoffMs(state.attempt, this.backoff, this.deps.prng));
      state.attempt += 1;
    }

    this.result = {
      eventsEmitted: state.seq,
      gapsDetected: state.gaps,
      reconnects: state.reconnects,
    };
    this.resolveDone(this.result);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  done(): Promise<FeedRunResult> {
    return this.donePromise;
  }

  private envelope<TPayload>(payload: TPayload, state: RunState): FeedEnvelope<TPayload> {
    const envelope = {
      source: 'live-sse' as const,
      seq: state.seq,
      receivedAtMs: this.deps.clock.nowMs(),
      payload,
    };
    state.seq += 1;
    return envelope;
  }

  private statusEvent(kind: FeedStatusKind, detail: string, state: RunState): FeedEvent {
    return { kind: 'feed-status', envelope: this.envelope({ kind, detail }, state) };
  }

  private async *ingest(
    tagged: TaggedFrame,
    state: RunState,
    idempotency: IdempotencyTracker,
  ): AsyncGenerator<FeedEvent> {
    const { channel, frame } = tagged;
    if (frame.id !== undefined) {
      state.lastEventId = frame.id;
    }
    if (frame.event === 'heartbeat') {
      const tsMs = parseHeartbeatTs(frame.data) ?? this.deps.clock.nowMs();
      yield { kind: 'heartbeat', envelope: this.envelope<Heartbeat>({ tsMs }, state) };
      return;
    }
    if (frame.data === undefined) {
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(frame.data);
    } catch {
      state.gaps += 1;
      return;
    }

    if (channel === 'odds') {
      const parsed = parseWith(oddsPayloadSchema, json);
      if (!parsed.ok) {
        state.gaps += 1;
        return;
      }
      if (!idempotency.acceptOdds(parsed.value.MessageId)) {
        return;
      }
      const mapped = mapOddsPayload(parsed.value);
      if (!mapped.ok) {
        state.gaps += 1;
        return;
      }
      state.lastTsMs = Math.max(state.lastTsMs, mapped.value.tsMs);
      yield { kind: 'odds', envelope: this.envelope(mapped.value, state) };
      return;
    }

    const parsed = parseWith(scoresPayloadSchema, json);
    if (!parsed.ok) {
      state.gaps += 1;
      return;
    }
    if (!idempotency.acceptScore(parsed.value.FixtureId, parsed.value.Seq)) {
      return;
    }
    const mapped = mapScorePayload(parsed.value);
    if (!mapped.ok) {
      state.gaps += 1;
      return;
    }
    state.lastTsMs = Math.max(state.lastTsMs, mapped.value.tsMs);
    yield { kind: 'score', envelope: this.envelope(mapped.value, state) };
  }

  private async *backfill(state: RunState, idempotency: IdempotencyTracker): AsyncGenerator<FeedEvent> {
    const intervals = this.deps.backfillIntervals?.(state.lastTsMs) ?? [];
    if (intervals.length === 0) {
      return;
    }
    yield this.statusEvent('backfilling', `${intervals.length} interval(s)`, state);
    for (const coord of intervals) {
      const odds = await this.deps.client.getOddsUpdates(
        coord.epochDay,
        coord.hourOfDay,
        coord.interval,
      );
      if (odds.ok) {
        for (const raw of odds.value) {
          if (!idempotency.acceptOdds(raw.MessageId)) {
            continue;
          }
          const mapped = mapOddsPayload(raw);
          if (mapped.ok) {
            yield { kind: 'odds', envelope: this.envelope(mapped.value, state) };
          } else {
            state.gaps += 1;
          }
        }
      } else {
        state.gaps += 1;
        yield {
          kind: 'gap',
          envelope: this.envelope<GapInfo>({ channel: 'odds', detail: 'backfill odds failed' }, state),
        };
      }

      const scores = await this.deps.client.getScoresUpdates(
        coord.epochDay,
        coord.hourOfDay,
        coord.interval,
      );
      if (scores.ok) {
        for (const raw of scores.value) {
          if (!idempotency.acceptScore(raw.FixtureId, raw.Seq)) {
            continue;
          }
          const mapped = mapScorePayload(raw);
          if (mapped.ok) {
            yield { kind: 'score', envelope: this.envelope(mapped.value, state) };
          } else {
            state.gaps += 1;
          }
        }
      } else {
        state.gaps += 1;
        yield {
          kind: 'gap',
          envelope: this.envelope<GapInfo>({ channel: 'score', detail: 'backfill scores failed' }, state),
        };
      }
    }
  }
}
