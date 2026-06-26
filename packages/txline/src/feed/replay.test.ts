import { describe, expect, it } from 'vitest';
import { err, ManualClock, ok, type FeedEvent } from '@txline-agent/core';
import type { TxlineError } from '../http/types.js';
import type { OddsPayload } from '../schemas/odds.js';
import type { ScoresPayload } from '../schemas/scores.js';
import { ReplayFeed } from './replay.js';
import { RecordedReplaySource, type IntervalCoord, type ReplaySource } from './source.js';

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

const scoreRaw = (
  fixtureId: number,
  tsMs: number,
  seq: number,
  home: number,
  away: number,
): ScoresPayload => ({
  fixtureId,
  gameState: 'H1',
  startTime: tsMs - 1000,
  isTeam: true,
  fixtureGroupId: 1,
  competitionId: 1,
  countryId: 1,
  sportId: 1,
  participant1IsHome: true,
  participant2Id: 2,
  participant1Id: 1,
  action: 'goal',
  id: seq,
  ts: tsMs,
  connectionId: 1,
  seq,
  stats: { '1': home, '2': away },
});

const intervals: IntervalCoord[] = [{ epochDay: 20000, hourOfDay: 15, interval: 0 }];
const INTERVAL_KEY = '20000:15:0';

const makeSource = (): RecordedReplaySource =>
  new RecordedReplaySource(
    new Map([
      [
        INTERVAL_KEY,
        [oddsRaw(17588227, 1000, [2100, 3400, 3600]), oddsRaw(17588227, 3000, [2000, 3500, 3700])],
      ],
    ]),
    new Map([[INTERVAL_KEY, [scoreRaw(17588227, 2000, 1, 1, 0)]]]),
  );

const collect = async (feed: ReplayFeed): Promise<FeedEvent[]> => {
  const events: FeedEvent[] = [];
  for await (const event of feed.events()) {
    events.push(event);
  }
  return events;
};

const mapReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Map ? Array.from(value.entries()) : value;
const stable = (events: readonly FeedEvent[]): string => JSON.stringify(events, mapReplacer);

describe('ReplayFeed', () => {
  it('emits events in timestamp order and advances the clock', async () => {
    const clock = new ManualClock(0);
    const events = await collect(new ReplayFeed({ source: makeSource(), clock, intervals }));
    expect(events).toHaveLength(3);
    expect(events[0]?.kind).toBe('odds');
    expect(events[0]?.envelope.receivedAtMs).toBe(1000);
    expect(events[1]?.kind).toBe('score');
    expect(events[1]?.envelope.receivedAtMs).toBe(2000);
    expect(events[2]?.kind).toBe('odds');
    expect(events[2]?.envelope.receivedAtMs).toBe(3000);
    expect(events.map((event) => event.envelope.seq)).toEqual([0, 1, 2]);
    expect(clock.nowMs()).toBe(3000);
  });

  it('is deterministic: the same input twice yields byte-identical events', async () => {
    const first = await collect(
      new ReplayFeed({ source: makeSource(), clock: new ManualClock(0), intervals }),
    );
    const second = await collect(
      new ReplayFeed({ source: makeSource(), clock: new ManualClock(0), intervals }),
    );
    expect(stable(first)).toBe(stable(second));
  });

  it('counts a gap when an interval fetch fails', async () => {
    const serverError: TxlineError = { kind: 'server-error', status: 503, detail: 'down' };
    const failing: ReplaySource = {
      oddsInterval: () => Promise.resolve(err(serverError)),
      scoresInterval: () => Promise.resolve(ok([])),
    };
    const feed = new ReplayFeed({ source: failing, clock: new ManualClock(0), intervals });
    await collect(feed);
    const result = await feed.done();
    expect(result.gapsDetected).toBe(1);
    expect(result.eventsEmitted).toBe(0);
  });
});
