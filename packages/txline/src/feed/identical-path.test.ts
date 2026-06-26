import { describe, expect, it } from 'vitest';
import { ManualClock, SeededPrng, type FeedEvent } from '@txline-agent/core';
import { TxlineClient, type TxlineClientDeps } from '../http/client.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../http/types.js';
import type { OddsPayload } from '../schemas/odds.js';
import type { ScoresPayload } from '../schemas/scores.js';
import { LiveSseFeed, type SseConnector, type TaggedFrame } from './live.js';
import { ReplayFeed } from './replay.js';
import { RecordedReplaySource, type IntervalCoord } from './source.js';

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
  Pct: ['47.619', '29.412', '27.778'],
});

const scoreRaw = (fixtureId: number, tsMs: number, seq: number): ScoresPayload => ({
  FixtureId: fixtureId,
  GameState: 'H1',
  Participant1IsHome: true,
  Ts: tsMs,
  Seq: seq,
  Stats: { '1': 1, '2': 0 },
});

// One dataset, in tsMs order, shared by both feeds.
const odds1000 = oddsRaw(17588227, 1000, [2100, 3400, 3600]);
const score2000 = scoreRaw(17588227, 2000, 1);
const odds3000 = oddsRaw(17588227, 3000, [2000, 3500, 3700]);

const intervals: IntervalCoord[] = [{ epochDay: 20000, hourOfDay: 15, interval: 0 }];
const INTERVAL_KEY = '20000:15:0';

const replaySource = new RecordedReplaySource(
  new Map([[INTERVAL_KEY, [odds1000, odds3000]]]),
  new Map([[INTERVAL_KEY, [score2000]]]),
);

const liveFrames: TaggedFrame[] = [
  { channel: 'odds', frame: { id: '1000:0', data: JSON.stringify(odds1000) } },
  { channel: 'scores', frame: { id: '2000:0', data: JSON.stringify(score2000) } },
  { channel: 'odds', frame: { id: '3000:0', data: JSON.stringify(odds3000) } },
];

class OnceConnector implements SseConnector {
  async *connect(_lastEventId: string | null): AsyncIterable<TaggedFrame> {
    for (const frame of liveFrames) {
      yield frame;
    }
  }
}

class UnusedHttp implements HttpClient {
  async send(_request: HttpRequest): Promise<HttpResponse> {
    throw new Error('the identical-path test never backfills');
  }
}

const clientDeps = (): TxlineClientDeps => ({
  http: new UnusedHttp(),
  sleep: async () => {},
  prng: new SeededPrng(9),
  dataBaseUrl: 'https://data',
  authBaseUrl: 'https://auth',
});

const collect = async (feed: { events(): AsyncIterable<FeedEvent> }): Promise<FeedEvent[]> => {
  const events: FeedEvent[] = [];
  for await (const event of feed.events()) {
    events.push(event);
  }
  return events;
};

const mapReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Map ? Array.from(value.entries()) : value;

type DataEvent = Extract<FeedEvent, { kind: 'odds' | 'score' }>;
const isData = (event: FeedEvent): event is DataEvent =>
  event.kind === 'odds' || event.kind === 'score';

// Project to the decision-relevant content: kind plus a stable serialization of the
// domain payload. Ignores source, seq, and receivedAtMs, which legitimately differ.
const project = (events: FeedEvent[]): { kind: string; payload: string }[] =>
  events
    .filter(isData)
    .map((event) => ({ kind: event.kind, payload: JSON.stringify(event.envelope.payload, mapReplacer) }));

describe('identical path: replay and live', () => {
  it('produce the same odds and score event sequence from the same data', async () => {
    const replayEvents = await collect(
      new ReplayFeed({ source: replaySource, clock: new ManualClock(0), intervals }),
    );
    const liveEvents = await collect(
      new LiveSseFeed({
        connector: new OnceConnector(),
        client: new TxlineClient(clientDeps(), { jwt: 'j', apiToken: 't' }),
        clock: new ManualClock(0),
        prng: new SeededPrng(1),
        sleep: async () => {},
        maxReconnects: 0,
      }),
    );

    expect(project(liveEvents)).toEqual(project(replayEvents));
    expect(project(replayEvents)).toHaveLength(3);
  });
});
