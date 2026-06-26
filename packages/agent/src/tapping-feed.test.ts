import { describe, expect, it } from 'vitest';
import type { Clock, Feed, FeedEvent, FeedRunResult, FeedStatusKind } from '@txline-agent/core';
import { AgentStateStore } from './state-store.js';
import { TappingFeed } from './tapping-feed.js';

class FixedClock implements Clock {
  nowMs(): number {
    return 1_000;
  }
}

class ArrayFeed implements Feed {
  constructor(private readonly items: readonly FeedEvent[]) {}

  async *events(): AsyncIterable<FeedEvent> {
    for (const item of this.items) {
      yield item;
    }
  }

  async stop(): Promise<void> {}

  async done(): Promise<FeedRunResult> {
    return { eventsEmitted: this.items.length, gapsDetected: 0, reconnects: 0 };
  }
}

const statusEvent = (kind: FeedStatusKind, detail: string): FeedEvent => ({
  kind: 'feed-status',
  envelope: { source: 'live-sse', seq: 0, receivedAtMs: 1_000, payload: { kind, detail } },
});

const heartbeatEvent = (): FeedEvent => ({
  kind: 'heartbeat',
  envelope: { source: 'live-sse', seq: 1, receivedAtMs: 1_000, payload: { tsMs: 1_000 } },
});

describe('TappingFeed', () => {
  it('counts events and records connection status while forwarding every event unchanged', async () => {
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 0n });
    const feed = new TappingFeed(
      new ArrayFeed([
        statusEvent('connected', 'initial connection'),
        heartbeatEvent(),
        statusEvent('reconnecting', 'connection error'),
      ]),
      store,
    );

    const forwarded: string[] = [];
    for await (const event of feed.events()) {
      forwarded.push(event.kind);
    }

    expect(forwarded).toEqual(['feed-status', 'heartbeat', 'feed-status']);
    const snapshot = store.snapshot();
    expect(snapshot.eventsProcessed).toBe(3);
    expect(snapshot.feedStatus?.kind).toBe('reconnecting');
    expect(snapshot.feedStatus?.detail).toBe('connection error');
  });

  it('delegates stop and done to the inner feed', async () => {
    const store = new AgentStateStore({ clock: new FixedClock(), startingBankroll: 0n });
    const feed = new TappingFeed(new ArrayFeed([heartbeatEvent()]), store);
    await feed.stop();
    const result = await feed.done();
    expect(result.eventsEmitted).toBe(1);
  });
});
