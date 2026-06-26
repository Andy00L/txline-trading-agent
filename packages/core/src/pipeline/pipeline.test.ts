import { describe, expect, it } from 'vitest';
import type { Feed, FeedEvent, FeedRunResult } from '../feed.js';
import { marketKey, type MarketKey } from '../domain/market.js';
import { decimalOddsMilli, microUsdSaturating, type DecimalOddsMilli } from '../units.js';
import { runPipeline, type PipelineConfig } from './pipeline.js';
import type { CommittedPosition, PipelineSink, SettledPosition } from './sink.js';

const FIXTURE_ID = 17588302;
const MKEY: MarketKey = marketKey({
  fixtureId: FIXTURE_ID,
  superOddsType: 'StablePrice',
  marketPeriod: '0',
  marketParameters: '',
});

const oddsMilli = (value: number): DecimalOddsMilli => {
  const result = decimalOddsMilli(value);
  if (!result.ok) {
    throw new Error(`bad odds ${value}`);
  }
  return result.value;
};

// One in-memory feed replaying a fixed event list, so the pipeline can be driven without
// any IO. A slightly under-round book is used on purpose so the de-vigged fair probability
// clears the offered price and the steam path produces a real +EV decision.
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

const oddsEvent = (
  seq: number,
  tsMs: number,
  homeMilli: number,
  drawMilli: number,
  awayMilli: number,
): FeedEvent => ({
  kind: 'odds',
  envelope: {
    source: 'replay',
    seq,
    receivedAtMs: tsMs,
    payload: {
      fixtureId: FIXTURE_ID,
      messageId: `m${seq}`,
      tsMs,
      bookmakerId: 0,
      superOddsType: 'StablePrice',
      inRunning: false,
      marketKey: MKEY,
      lines: [
        { outcome: 'home', decimalOddsMilli: oddsMilli(homeMilli), impliedPct: null },
        { outcome: 'draw', decimalOddsMilli: oddsMilli(drawMilli), impliedPct: null },
        { outcome: 'away', decimalOddsMilli: oddsMilli(awayMilli), impliedPct: null },
      ],
    },
  },
});

// gameState 'F' is the live-confirmed final (ended) phase. sourceRef: score-state.ts (O9).
const scoreEvent = (
  seq: number,
  tsMs: number,
  home: number,
  away: number,
  gameState = 'F',
): FeedEvent => ({
  kind: 'score',
  envelope: {
    source: 'replay',
    seq,
    receivedAtMs: tsMs,
    payload: {
      fixtureId: FIXTURE_ID,
      seq,
      tsMs,
      gameState,
      participant1IsHome: true,
      homeGoals: home,
      awayGoals: away,
      stats: new Map<number, number>(),
    },
  },
});

// Home shortens across three snapshots (steam up), then home wins 2-1.
const scenario = (): readonly FeedEvent[] => [
  oddsEvent(0, 1_000, 2600, 3600, 3600),
  oddsEvent(1, 60_000, 2300, 3800, 3800),
  oddsEvent(2, 120_000, 2100, 4000, 4000),
  scoreEvent(3, 7_200_000, 2, 1),
];

const config: PipelineConfig = {
  devigMethod: 'multiplicative',
  steam: { windowMs: 600_000, minProbMove: 0.03, minEdge: 0.01 },
  divergence: { minEdge: 0.01, minProb: 0.05, maxProb: 0.95 },
  decision: {
    kelly: { fraction: 0.5, maxFractionOfBankroll: 0.1 },
    risk: {
      bankrollFloor: microUsdSaturating(0n),
      maxStakePerOrder: microUsdSaturating(100_000_000n),
      maxConcurrent: 5,
      totalExposureCap: microUsdSaturating(500_000_000n),
      perFixtureExposureCap: microUsdSaturating(200_000_000n),
      perMarketExposureCap: microUsdSaturating(200_000_000n),
      staleFeedMs: 600_000,
      outlierOddsZ: 3,
      maxDailyDrawdown: microUsdSaturating(1_000_000_000n),
    },
  },
  startingBankroll: microUsdSaturating(1_000_000_000n),
  steamHistoryLimit: 50,
};

class RecordingSink implements PipelineSink {
  readonly commits: CommittedPosition[] = [];
  readonly settles: SettledPosition[] = [];

  onCommit(position: CommittedPosition): void {
    this.commits.push(position);
  }

  onSettle(position: SettledPosition): void {
    this.settles.push(position);
  }
}

const serialize = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item));

describe('runPipeline', () => {
  it('detects steam, commits one decision, and settles it against the final score', async () => {
    const sink = new RecordingSink();
    const result = await runPipeline(new ArrayFeed(scenario()), sink, config);

    expect(result.committed).toBe(1);
    expect(result.settled).toBe(1);
    expect(sink.commits).toHaveLength(1);
    expect(sink.settles).toHaveLength(1);

    const settled = sink.settles[0];
    expect(settled?.decision.outcome).toBe('home');
    expect(settled?.result).toBe('home');
    expect(settled?.won).toBe(true);
    expect((settled?.pnl ?? 0n) > 0n).toBe(true);
    expect(result.finalBankroll > config.startingBankroll).toBe(true);
  });

  it('commits only once per market even as the line keeps moving', async () => {
    const sink = new RecordingSink();
    await runPipeline(new ArrayFeed(scenario()), sink, config);
    expect(sink.commits).toHaveLength(1);
  });

  it('is deterministic: the same feed produces byte-identical decisions and settlements', async () => {
    const first = new RecordingSink();
    const second = new RecordingSink();
    await runPipeline(new ArrayFeed(scenario()), first, config);
    await runPipeline(new ArrayFeed(scenario()), second, config);

    expect(serialize(first.commits)).toBe(serialize(second.commits));
    expect(serialize(first.settles)).toBe(serialize(second.settles));
  });

  it('settles on the final-whistle score, not an in-running snapshot (A-9)', async () => {
    // Same steam-up entry on home, but an in-running 0-0 ('H1') arrives before the final
    // 2-1 ('F'). Settling on the in-running snapshot would score the home bet a draw-loss;
    // only the final whistle must settle it, as a home win against seq 4.
    const sink = new RecordingSink();
    const result = await runPipeline(
      new ArrayFeed([
        oddsEvent(0, 1_000, 2600, 3600, 3600),
        oddsEvent(1, 60_000, 2300, 3800, 3800),
        oddsEvent(2, 120_000, 2100, 4000, 4000),
        scoreEvent(3, 3_000_000, 0, 0, 'H1'),
        scoreEvent(4, 7_200_000, 2, 1, 'F'),
      ]),
      sink,
      config,
    );

    expect(result.settled).toBe(1);
    expect(sink.settles).toHaveLength(1);
    const settled = sink.settles[0];
    expect(settled?.settledSeq).toBe(4);
    expect(settled?.result).toBe('home');
    expect(settled?.won).toBe(true);
  });
});
