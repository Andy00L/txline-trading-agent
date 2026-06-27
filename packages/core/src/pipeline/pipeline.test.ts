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

  it('leaves a position open when the fixture never reaches a final whistle (B2)', async () => {
    // Steam fires and a bet is committed, but only in-running scores arrive (feed cut off
    // before the whistle). The bet must stay open and unrealized, never settled against an
    // in-running snapshot.
    const sink = new RecordingSink();
    const result = await runPipeline(
      new ArrayFeed([
        oddsEvent(0, 1_000, 2600, 3600, 3600),
        oddsEvent(1, 60_000, 2300, 3800, 3800),
        oddsEvent(2, 120_000, 2100, 4000, 4000),
        scoreEvent(3, 3_000_000, 1, 0, 'H2'),
        scoreEvent(4, 5_000_000, 2, 1, 'H2'),
      ]),
      sink,
      config,
    );
    expect(result.committed).toBe(1);
    expect(result.settled).toBe(0);
    expect(sink.settles).toHaveLength(0);
  });

  it('locks on the first final whistle even if a corrected final arrives later (B1/B3)', async () => {
    // First final 2-1 (home win) at seq 4, then a corrected final 2-2 (draw) at seq 5. The bet
    // settles once, against the first final: home win, settledSeq 4.
    const sink = new RecordingSink();
    const result = await runPipeline(
      new ArrayFeed([
        oddsEvent(0, 1_000, 2600, 3600, 3600),
        oddsEvent(1, 60_000, 2300, 3800, 3800),
        oddsEvent(2, 120_000, 2100, 4000, 4000),
        scoreEvent(4, 7_200_000, 2, 1, 'F'),
        scoreEvent(5, 7_260_000, 2, 2, 'F'),
      ]),
      sink,
      config,
    );
    expect(result.settled).toBe(1);
    expect(sink.settles).toHaveLength(1);
    expect(sink.settles[0]?.settledSeq).toBe(4);
    expect(sink.settles[0]?.result).toBe('home');
    expect(sink.settles[0]?.won).toBe(true);
  });

  it('settles on an extra-time final (FET), not only regulation (F)', async () => {
    const sink = new RecordingSink();
    const result = await runPipeline(
      new ArrayFeed([
        oddsEvent(0, 1_000, 2600, 3600, 3600),
        oddsEvent(1, 60_000, 2300, 3800, 3800),
        oddsEvent(2, 120_000, 2100, 4000, 4000),
        scoreEvent(3, 9_000_000, 3, 1, 'FET'),
      ]),
      sink,
      config,
    );
    expect(result.settled).toBe(1);
    expect(sink.settles[0]?.result).toBe('home');
    expect(sink.settles[0]?.settledSeq).toBe(3);
  });

  it('ignores a stale in-running frame that arrives after the final whistle (B1)', async () => {
    // The final 2-1 (home) settles at seq 4; a later, higher-seq in-running 'H2' 3-3 frame (out
    // of order) must neither re-settle nor change the recorded result.
    const sink = new RecordingSink();
    const result = await runPipeline(
      new ArrayFeed([
        oddsEvent(0, 1_000, 2600, 3600, 3600),
        oddsEvent(1, 60_000, 2300, 3800, 3800),
        oddsEvent(2, 120_000, 2100, 4000, 4000),
        scoreEvent(4, 7_200_000, 2, 1, 'F'),
        scoreEvent(5, 7_300_000, 3, 3, 'H2'),
      ]),
      sink,
      config,
    );
    expect(result.settled).toBe(1);
    expect(sink.settles).toHaveLength(1);
    expect(sink.settles[0]?.settledSeq).toBe(4);
    expect(sink.settles[0]?.result).toBe('home');
  });

  it('marks the closing line known when a consensus update arrives after entry (B4)', async () => {
    // A 4th odds snapshot after the steam entry updates the consensus line, so CLV is known.
    const sink = new RecordingSink();
    await runPipeline(
      new ArrayFeed([
        oddsEvent(0, 1_000, 2600, 3600, 3600),
        oddsEvent(1, 60_000, 2300, 3800, 3800),
        oddsEvent(2, 120_000, 2100, 4000, 4000),
        oddsEvent(3, 180_000, 2000, 4200, 4200),
        scoreEvent(4, 7_200_000, 2, 1, 'F'),
      ]),
      sink,
      config,
    );
    const settled = sink.settles[0];
    expect(settled).toBeDefined();
    if (settled) {
      expect(settled.closingFairProbKnown).toBe(true);
      // Home shortened further after entry, so the closing fair prob exceeds the entry prob.
      expect(settled.closingFairProb > settled.decision.fairProb).toBe(true);
    }
  });

  it('marks the closing line unknown when no consensus update follows entry (B4)', async () => {
    // The decision commits on the only odds snapshot, so no later consensus observation exists:
    // the closing line is unknown and falls back to the entry prob (excluded from CLV, not a 0).
    const sink = new RecordingSink();
    await runPipeline(
      new ArrayFeed([
        oddsEvent(0, 1_000, 2600, 3600, 3600),
        scoreEvent(1, 7_200_000, 2, 1, 'F'),
      ]),
      sink,
      config,
    );
    const settled = sink.settles[0];
    expect(settled).toBeDefined();
    if (settled) {
      expect(settled.closingFairProbKnown).toBe(false);
      // Falls back to the entry prob exactly, so the CLV is a definitional zero, not a real one.
      expect(settled.closingFairProb).toBe(settled.decision.fairProb);
    }
  });
});
