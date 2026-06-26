import type { FixtureUpdate, OddsUpdate, ScoreUpdate } from './domain/events.js';

/**
 * The Feed abstraction. One interface drives both live and replay, so a green
 * replay backtest is direct evidence about live behaviour. The concrete feeds
 * (LiveSseFeed, ReplayFeed) live in txline; core only owns the contract.
 * sourceRef: docs/BUILD_PLAN.md (Feed abstraction).
 */

export type FeedSource = 'live-sse' | 'replay';

export type FeedEnvelope<TPayload> = {
  readonly source: FeedSource;
  readonly seq: number; // monotonic within a run, assigned at ingest
  readonly receivedAtMs: number; // Clock time when the event was ingested
  readonly payload: TPayload;
};

export type FeedStatusKind = 'connected' | 'reconnecting' | 'backfilling' | 'stopped';
export type FeedStatus = { readonly kind: FeedStatusKind; readonly detail: string };

export type FeedChannel = 'odds' | 'score' | 'fixture';
export type GapInfo = { readonly channel: FeedChannel; readonly detail: string };
export type Heartbeat = { readonly tsMs: number };

export type FeedEvent =
  | { readonly kind: 'odds'; readonly envelope: FeedEnvelope<OddsUpdate> }
  | { readonly kind: 'score'; readonly envelope: FeedEnvelope<ScoreUpdate> }
  | { readonly kind: 'fixture'; readonly envelope: FeedEnvelope<FixtureUpdate> }
  | { readonly kind: 'heartbeat'; readonly envelope: FeedEnvelope<Heartbeat> }
  | { readonly kind: 'gap'; readonly envelope: FeedEnvelope<GapInfo> }
  | { readonly kind: 'feed-status'; readonly envelope: FeedEnvelope<FeedStatus> };

export type FeedRunResult = {
  readonly eventsEmitted: number;
  readonly gapsDetected: number;
  readonly reconnects: number;
};

export interface Feed {
  /** The event stream. Consumed once, in order. */
  events(): AsyncIterable<FeedEvent>;
  /** Request an orderly stop; the iterable completes after the in-flight event. */
  stop(): Promise<void>;
  /** Resolves with run totals after the stream completes. */
  done(): Promise<FeedRunResult>;
}
