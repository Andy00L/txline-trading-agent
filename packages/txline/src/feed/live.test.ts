import { describe, expect, it } from 'vitest';
import { ManualClock, SeededPrng, type FeedEvent, type Prng } from '@txline-agent/core';
import { TxlineClient, type TxlineClientDeps } from '../http/client.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http/types.js';
import type { OddsPayload } from '../schemas/odds.js';
import type { ScoresPayload } from '../schemas/scores.js';
import { LiveSseFeed, type SseConnector, type SseResumeIds, type TaggedFrame } from './live.js';

const oddsRaw = (fixtureId: number, tsMs: number, prices: number[]): OddsPayload => ({
  FixtureId: fixtureId,
  MessageId: `${fixtureId}:${tsMs}`,
  Ts: tsMs,
  Bookmaker: 'SP',
  BookmakerId: 0,
  SuperOddsType: 'StablePrice',
  InRunning: false,
  MarketPeriod: 'FT',
  MarketParameters: '',
  PriceNames: ['1', 'X', '2'],
  Prices: prices,
  Pct: ['NA', 'NA', 'NA'],
});

const scoreRaw = (fixtureId: number, tsMs: number, seq: number): ScoresPayload => ({
  FixtureId: fixtureId,
  GameState: 'H1',
  Participant1IsHome: true,
  Ts: tsMs,
  Seq: seq,
  Stats: { '1': 1, '2': 0 },
});

const oddsFrame = (fixtureId: number, tsMs: number, prices: number[]): TaggedFrame => ({
  channel: 'odds',
  frame: { id: `${tsMs}:0`, data: JSON.stringify(oddsRaw(fixtureId, tsMs, prices)) },
});

const scoreFrame = (fixtureId: number, tsMs: number, seq: number): TaggedFrame => ({
  channel: 'scores',
  frame: { id: `${tsMs}:0`, data: JSON.stringify(scoreRaw(fixtureId, tsMs, seq)) },
});

const heartbeatFrame = (tsMs: number): TaggedFrame => ({
  channel: 'odds',
  frame: { event: 'heartbeat', data: JSON.stringify({ Ts: tsMs }) },
});

class MockConnector implements SseConnector {
  public connectCount = 0;
  private readonly connections: (readonly TaggedFrame[] | Error)[];

  constructor(connections: readonly (readonly TaggedFrame[] | Error)[]) {
    this.connections = [...connections];
  }

  async *connect(_resume: SseResumeIds): AsyncIterable<TaggedFrame> {
    this.connectCount += 1;
    const connection = this.connections.shift();
    if (connection === undefined || connection instanceof Error) {
      if (connection instanceof Error) {
        throw connection;
      }
      return;
    }
    for (const frame of connection) {
      yield frame;
    }
  }
}

class MockHttp implements HttpClient {
  private readonly queue: (HttpResponse | Error)[];

  constructor(queue: readonly (HttpResponse | Error)[]) {
    this.queue = [...queue];
  }

  async send(_request: HttpRequest): Promise<HttpResponse> {
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error('mock: no queued response');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

const clientDeps = (http: HttpClient): TxlineClientDeps => ({
  http,
  sleep: async () => {},
  prng: new SeededPrng(2),
  dataBaseUrl: 'https://data',
  authBaseUrl: 'https://auth',
  backoff: { baseMs: 1, maxMs: 10, maxAttempts: 3 },
});

const collect = async (feed: { events(): AsyncIterable<FeedEvent> }): Promise<FeedEvent[]> => {
  const events: FeedEvent[] = [];
  for await (const event of feed.events()) {
    events.push(event);
  }
  return events;
};

type DataEvent = Extract<FeedEvent, { kind: 'odds' | 'score' }>;
const isData = (event: FeedEvent): event is DataEvent =>
  event.kind === 'odds' || event.kind === 'score';

describe('LiveSseFeed', () => {
  it('ingests frames, emits domain events, and dedups by key', async () => {
    const duplicate = oddsFrame(1, 1000, [2100, 3400, 3600]);
    const connector = new MockConnector([
      [duplicate, scoreFrame(1, 2000, 1), heartbeatFrame(2500), duplicate],
    ]);
    const client = new TxlineClient(clientDeps(new MockHttp([])), { jwt: 'j', apiToken: 't' });
    const events = await collect(
      new LiveSseFeed({
        connector,
        client,
        clock: new ManualClock(0),
        prng: new SeededPrng(1),
        sleep: async () => {},
        maxReconnects: 0,
      }),
    );
    const data = events.filter(isData);
    expect(data).toHaveLength(2);
    expect(data[0]?.kind).toBe('odds');
    expect(data[1]?.kind).toBe('score');
    expect(events.some((event) => event.kind === 'heartbeat')).toBe(true);
  });

  it('reconnects, backfills the gap, and dedups the overlap', async () => {
    const connector = new MockConnector([
      [oddsFrame(1, 1000, [2100, 3400, 3600])],
      [oddsFrame(1, 3000, [2000, 3500, 3700])],
    ]);
    const backfillOdds = [oddsRaw(1, 2000, [2050, 3450, 3650]), oddsRaw(1, 1000, [2100, 3400, 3600])];
    const http = new MockHttp([
      { status: 200, body: JSON.stringify(backfillOdds) },
      { status: 200, body: JSON.stringify([]) },
    ]);
    const client = new TxlineClient(clientDeps(http), { jwt: 'j', apiToken: 't' });
    const feed = new LiveSseFeed({
      connector,
      client,
      clock: new ManualClock(0),
      prng: new SeededPrng(1),
      sleep: async () => {},
      backoff: { baseMs: 1, maxMs: 10, maxAttempts: 3 },
      maxReconnects: 1,
      backfillIntervals: () => [{ epochDay: 20000, hourOfDay: 15, interval: 0 }],
    });
    const events = await collect(feed);
    const timestamps = events.filter(isData).map((event) => event.envelope.payload.tsMs);
    expect(timestamps).toEqual([1000, 2000, 3000]);
    const result = await feed.done();
    expect(result.reconnects).toBe(1);
  });

  it('emits a gap event for a malformed live frame instead of dropping it silently (C4)', async () => {
    const badFrame: TaggedFrame = { channel: 'odds', frame: { id: '1', data: '{not json' } };
    const connector = new MockConnector([[badFrame]]);
    const client = new TxlineClient(clientDeps(new MockHttp([])), { jwt: 'j', apiToken: 't' });
    const feed = new LiveSseFeed({
      connector,
      client,
      clock: new ManualClock(0),
      prng: new SeededPrng(1),
      sleep: async () => {},
      maxReconnects: 0,
    });
    const events = await collect(feed);
    const gap = events.find((event) => event.kind === 'gap');
    expect(gap).toBeDefined();
    if (gap && gap.kind === 'gap') {
      expect(gap.envelope.payload.channel).toBe('odds');
    }
    expect((await feed.done()).gapsDetected).toBe(1);
  });

  it('resets the backoff after a healthy connection so one drop does not start at max (C2)', async () => {
    const sleeps: number[] = [];
    const constantPrng: Prng = { next: () => 0.5 };
    const connector = new MockConnector([
      [oddsFrame(1, 1000, [2100, 3400, 3600])],
      [oddsFrame(1, 2000, [2050, 3450, 3650])],
      [oddsFrame(1, 3000, [2000, 3500, 3700])],
      [oddsFrame(1, 4000, [1950, 3550, 3750])],
    ]);
    const client = new TxlineClient(clientDeps(new MockHttp([])), { jwt: 'j', apiToken: 't' });
    const feed = new LiveSseFeed({
      connector,
      client,
      clock: new ManualClock(0),
      prng: constantPrng,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      backoff: { baseMs: 100, maxMs: 100_000, maxAttempts: 5 },
      maxReconnects: 3,
    });
    await collect(feed);
    // Each connection delivered a frame (healthy), so the backoff resets to attempt 0 every
    // cycle: floor(0.5 * 100 * 2^0) = 50. Without the reset it would climb 50, 100, 200.
    expect(sleeps).toEqual([50, 50, 50]);
  });
});
