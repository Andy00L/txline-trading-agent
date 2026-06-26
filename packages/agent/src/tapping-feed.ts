import type { Feed, FeedEvent, FeedRunResult } from '@txline-agent/core';
import type { AgentStateStore } from './state-store.js';

/**
 * A Feed decorator that records run progress into the state store while forwarding every
 * event unchanged. It counts ingested events and surfaces connection status (connected,
 * reconnecting, backfilling, stopped) so the read-only API can show the live pipeline state.
 * It alters no event, so the decision path downstream is identical to the undecorated feed.
 */
export class TappingFeed implements Feed {
  private readonly inner: Feed;
  private readonly store: AgentStateStore;

  constructor(inner: Feed, store: AgentStateStore) {
    this.inner = inner;
    this.store = store;
  }

  async *events(): AsyncIterable<FeedEvent> {
    for await (const event of this.inner.events()) {
      this.store.recordEvent();
      if (event.kind === 'feed-status') {
        this.store.recordFeedStatus(event.envelope.payload.kind, event.envelope.payload.detail);
      }
      yield event;
    }
  }

  stop(): Promise<void> {
    return this.inner.stop();
  }

  done(): Promise<FeedRunResult> {
    return this.inner.done();
  }
}
