import { describe, expect, it } from 'vitest';
import type { Feed, FeedEvent, FeedRunResult } from '../feed.js';
import {
  marketKey,
  SUPER_ODDS_TYPE_1X2,
  SUPER_ODDS_TYPE_OVER_UNDER,
  type MarketKey,
  type OddsLine,
} from '../domain/market.js';
import { DEFAULT_CROSS_MARKET_CONFIG } from '../signal/cross-market.js';
import { DEFAULT_ELO_OVERLAY_CONFIG } from '../quant/elo.js';
import { scorelineMatrix } from '../quant/poisson.js';
import {
  DEFAULT_GOALS_MODEL_CONFIG,
  matchResultProbs,
  overProb,
  supremacyTotalToRates,
} from '../quant/surface.js';
import { decimalOddsMilli, microUsdSaturating, type DecimalOddsMilli } from '../units.js';
import { runPipeline, type PipelineConfig } from './pipeline.js';
import type { CommittedPosition, PipelineSink, SettledPosition } from './sink.js';

const FIXTURE_ID = 17588302;
const PARTICIPANT1_ID = 101;
const PARTICIPANT2_ID = 202;
const RHO = DEFAULT_GOALS_MODEL_CONFIG.rho;
const MAX_GOALS = DEFAULT_GOALS_MODEL_CONFIG.maxGoals;

const matchKey: MarketKey = marketKey({
  fixtureId: FIXTURE_ID,
  superOddsType: SUPER_ODDS_TYPE_1X2,
  marketPeriod: '',
  marketParameters: '',
});
const overUnderKey = (line: number): MarketKey =>
  marketKey({
    fixtureId: FIXTURE_ID,
    superOddsType: SUPER_ODDS_TYPE_OVER_UNDER,
    marketPeriod: '',
    marketParameters: `line=${line}`,
  });

const oddsMilliFromProb = (probability: number): DecimalOddsMilli => {
  const result = decimalOddsMilli(Math.round(1000 / probability));
  if (!result.ok) {
    throw new Error(`bad odds for prob ${probability}`);
  }
  return result.value;
};

const matrixFor = (supremacy: number, total: number): readonly (readonly number[])[] =>
  scorelineMatrix({ ...supremacyTotalToRates(supremacy, total), rho: RHO, maxGoals: MAX_GOALS });

// A de-margined 1X2 book whose implied probabilities are the model probabilities at (supremacy, total).
const matchLines = (supremacy: number, total: number): OddsLine[] => {
  const match = matchResultProbs(matrixFor(supremacy, total));
  return [
    { outcome: 'home', label: 'part1', decimalOddsMilli: oddsMilliFromProb(match.home), impliedPct: null },
    { outcome: 'draw', label: 'draw', decimalOddsMilli: oddsMilliFromProb(match.draw), impliedPct: null },
    { outcome: 'away', label: 'part2', decimalOddsMilli: oddsMilliFromProb(match.away), impliedPct: null },
  ];
};

// A de-margined Over/Under book whose over probability is the model probability at (supremacy, total).
const overUnderLines = (supremacy: number, total: number, line: number): OddsLine[] => {
  const probOver = overProb(matrixFor(supremacy, total), line);
  return [
    { outcome: 'other', label: 'over', decimalOddsMilli: oddsMilliFromProb(probOver), impliedPct: null },
    { outcome: 'other', label: 'under', decimalOddsMilli: oddsMilliFromProb(1 - probOver), impliedPct: null },
  ];
};

const oddsEvent = (
  seq: number,
  tsMs: number,
  marketKind: 'over-under',
  key: MarketKey,
  line: number,
  lines: readonly OddsLine[],
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
      superOddsType: SUPER_ODDS_TYPE_OVER_UNDER,
      inRunning: false,
      marketKey: key,
      marketKind,
      line,
      period: 'full-game',
      lines,
    },
  },
});

const matchEvent = (seq: number, tsMs: number, lines: readonly OddsLine[]): FeedEvent => ({
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
      superOddsType: SUPER_ODDS_TYPE_1X2,
      inRunning: false,
      marketKey: matchKey,
      marketKind: '1x2',
      line: null,
      period: 'full-game',
      lines,
    },
  },
});

// Kickoff is 2 hours into the timeline, so the pre-kickoff odds entries sit inside the
// cross-market lead window and the final whistle lands afterwards.
const KICKOFF_MS = 7_200_000;

// A pre-match "scheduled" record carries the kickoff time and no goals; it is how the pipeline
// learns time-to-kickoff before the match starts.
const scheduledScoreEvent = (seq: number, tsMs: number): FeedEvent => ({
  kind: 'score',
  envelope: {
    source: 'replay',
    seq,
    receivedAtMs: tsMs,
    payload: {
      fixtureId: FIXTURE_ID,
      seq,
      tsMs,
      gameState: 'scheduled',
      participant1IsHome: true,
      startTimeMs: KICKOFF_MS,
      homeGoals: null,
      awayGoals: null,
      stats: new Map<number, number>(),
    },
  },
});

const finalScoreEvent = (seq: number, tsMs: number, home: number, away: number): FeedEvent => ({
  kind: 'score',
  envelope: {
    source: 'replay',
    seq,
    receivedAtMs: tsMs,
    payload: {
      fixtureId: FIXTURE_ID,
      seq,
      tsMs,
      gameState: 'F',
      participant1IsHome: true,
      startTimeMs: KICKOFF_MS,
      homeGoals: home,
      awayGoals: away,
      stats: new Map<number, number>(),
    },
  },
});

// A fixtures-channel record naming the two participants, so the Elo overlay can key its ratings.
const fixtureEvent = (seq: number, tsMs: number): FeedEvent => ({
  kind: 'fixture',
  envelope: {
    source: 'replay',
    seq,
    receivedAtMs: tsMs,
    payload: {
      fixtureId: FIXTURE_ID,
      tsMs,
      startTimeMs: KICKOFF_MS,
      competition: 'World Cup',
      competitionId: 1,
      participant1Id: PARTICIPANT1_ID,
      participant1: 'Home',
      participant2Id: PARTICIPANT2_ID,
      participant2: 'Away',
      participant1IsHome: true,
    },
  },
});

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

const config: PipelineConfig = {
  devigMethod: 'shin',
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
      outlierOddsZ: 100,
      maxDailyDrawdown: microUsdSaturating(1_000_000_000n),
    },
  },
  startingBankroll: microUsdSaturating(1_000_000_000n),
  steamHistoryLimit: 50,
  crossMarket: DEFAULT_CROSS_MARKET_CONFIG,
};

describe('runPipeline cross-market strategy', () => {
  it('does not trade a fixture whose 1X2 and Over/Under markets agree', () => {
    // The scheduled score makes kickoff known so the time-to-kickoff gate passes; both markets
    // are generated from the same (supremacy 0.4, total 2.7), so the joint fit reproduces the
    // surface, every leg edge is ~0, and nothing clears the 2pp threshold.
    const events: FeedEvent[] = [
      scheduledScoreEvent(0, 500),
      matchEvent(1, 1_000, matchLines(0.4, 2.7)),
      oddsEvent(2, 60_000, 'over-under', overUnderKey(2.5), 2.5, overUnderLines(0.4, 2.7, 2.5)),
      oddsEvent(3, 90_000, 'over-under', overUnderKey(3.5), 3.5, overUnderLines(0.4, 2.7, 3.5)),
    ];
    const sink = new RecordingSink();
    return runPipeline(new ArrayFeed(events), sink, config).then((result) => {
      expect(result.committed).toBe(0);
      expect(sink.commits).toHaveLength(0);
    });
  });

  it('backs a 1X2 leg the Over/Under market disagrees with, sizes it, and settles it', async () => {
    // The 1X2 is priced at total 2.7 but the Over/Under ladder implies total 3.4 (more goals):
    // the joint fit raises the total, lifting the home/away win probabilities above the 1X2 line,
    // so a 1X2 leg is priced longer than the cross-market consensus and is backed.
    const events: FeedEvent[] = [
      scheduledScoreEvent(0, 500),
      matchEvent(1, 1_000, matchLines(0.4, 2.7)),
      oddsEvent(2, 60_000, 'over-under', overUnderKey(2.5), 2.5, overUnderLines(0.4, 3.4, 2.5)),
      oddsEvent(3, 90_000, 'over-under', overUnderKey(3.5), 3.5, overUnderLines(0.4, 3.4, 3.5)),
      // A later 1X2 snapshot gives a post-entry closing line so CLV is defined.
      matchEvent(4, 150_000, matchLines(0.7, 3.0)),
      finalScoreEvent(5, 14_400_000, 2, 1),
    ];
    const sink = new RecordingSink();
    const result = await runPipeline(new ArrayFeed(events), sink, config);

    expect(result.committed).toBe(1);
    expect(result.settled).toBe(1);
    const committed = sink.commits[0];
    expect(committed?.decision.signalKind).toBe('cross-market');
    expect(committed?.decision.outcome === 'home' || committed?.decision.outcome === 'away').toBe(true);
    // The model fair probability beats the 1X2 line, so Kelly sizes a real positive stake.
    expect((committed?.decision.stake ?? 0n) > 0n).toBe(true);
    expect((committed?.decision.edge ?? 0) > 0).toBe(true);

    const settled = sink.settles[0];
    expect(settled?.entryConsensusProb).toBeGreaterThan(0);
    expect(settled?.closingFairProbKnown).toBe(true);
  });

  it('is deterministic: the same surface produces the same decision twice', async () => {
    const build = (): FeedEvent[] => [
      scheduledScoreEvent(0, 500),
      matchEvent(1, 1_000, matchLines(0.4, 2.7)),
      oddsEvent(2, 60_000, 'over-under', overUnderKey(2.5), 2.5, overUnderLines(0.4, 3.4, 2.5)),
      finalScoreEvent(3, 14_400_000, 2, 1),
    ];
    const first = new RecordingSink();
    const second = new RecordingSink();
    await runPipeline(new ArrayFeed(build()), first, config);
    await runPipeline(new ArrayFeed(build()), second, config);
    const serialize = (value: unknown): string =>
      JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item));
    expect(serialize(first.commits)).toBe(serialize(second.commits));
    expect(serialize(first.settles)).toBe(serialize(second.settles));
  });

  it('the decorrelation overlay lifts the stake on a corroborating rating and cuts it on a contradicting one', async () => {
    // The same surface as the backed-leg case, plus a fixtures record so the overlay can key ratings
    // to the participants. The seed sets the ratings directly (no prior finals), so the rating's
    // residual against the market drives the stake multiplier, while the backed leg itself (chosen
    // by the market-only fit) is identical across all three runs: the overlay sizes, it never picks.
    const events = (): FeedEvent[] => [
      fixtureEvent(0, 400),
      scheduledScoreEvent(1, 500),
      matchEvent(2, 1_000, matchLines(0.4, 2.7)),
      oddsEvent(3, 60_000, 'over-under', overUnderKey(2.5), 2.5, overUnderLines(0.4, 3.4, 2.5)),
      oddsEvent(4, 90_000, 'over-under', overUnderKey(3.5), 3.5, overUnderLines(0.4, 3.4, 3.5)),
    ];
    // Headroom on the caps so the Kelly stake, not a cap, sets the result and the bounded multiplier
    // shows in the committed stake.
    const headroom: PipelineConfig = {
      ...config,
      decision: {
        ...config.decision,
        kelly: { fraction: 0.5, maxFractionOfBankroll: 0.9 },
        risk: {
          ...config.decision.risk,
          maxStakePerOrder: microUsdSaturating(900_000_000n),
          perFixtureExposureCap: microUsdSaturating(900_000_000n),
          perMarketExposureCap: microUsdSaturating(900_000_000n),
          totalExposureCap: microUsdSaturating(900_000_000n),
        },
      },
    };

    const base = new RecordingSink();
    await runPipeline(new ArrayFeed(events()), base, headroom);
    const backed = base.commits[0]?.decision.outcome;
    const baseStake = base.commits[0]?.decision.stake ?? 0n;
    expect(backed === 'home' || backed === 'away').toBe(true);
    expect(baseStake > 0n).toBe(true);

    // A large rating edge for the backed side: its rating probability exceeds the market's, a
    // positive residual that corroborates the back and lifts the stake.
    const strongFor = (id: number): ReadonlyMap<number, number> =>
      id === PARTICIPANT1_ID
        ? new Map([
            [PARTICIPANT1_ID, 1950],
            [PARTICIPANT2_ID, 1350],
          ])
        : new Map([
            [PARTICIPANT1_ID, 1350],
            [PARTICIPANT2_ID, 1950],
          ]);
    const backedId = backed === 'home' ? PARTICIPANT1_ID : PARTICIPANT2_ID;
    const otherId = backed === 'home' ? PARTICIPANT2_ID : PARTICIPANT1_ID;

    const up = new RecordingSink();
    await runPipeline(new ArrayFeed(events()), up, {
      ...headroom,
      eloOverlay: { ...DEFAULT_ELO_OVERLAY_CONFIG, seed: strongFor(backedId) },
    });
    expect(up.commits[0]?.decision.outcome).toBe(backed);
    expect((up.commits[0]?.decision.stake ?? 0n) > baseStake).toBe(true);

    // The mirror seed makes the backed side the weaker team: a negative residual that contradicts
    // the back and cuts the stake.
    const down = new RecordingSink();
    await runPipeline(new ArrayFeed(events()), down, {
      ...headroom,
      eloOverlay: { ...DEFAULT_ELO_OVERLAY_CONFIG, seed: strongFor(otherId) },
    });
    expect(down.commits[0]?.decision.outcome).toBe(backed);
    expect((down.commits[0]?.decision.stake ?? 0n) < baseStake).toBe(true);
  });
});
