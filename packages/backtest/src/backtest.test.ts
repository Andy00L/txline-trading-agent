import {
  decimalOddsMilli,
  marketKey,
  microUsdSaturating,
  type DecimalOddsMilli,
  type Feed,
  type FeedEvent,
  type FeedRunResult,
  type PipelineConfig,
} from '@txline-agent/core';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHtmlReport } from './html-report.js';
import { renderMarkdownReport } from './report.js';
import { runBacktest } from './run.js';
import { walkForward } from './walk-forward.js';
import { writeReportFiles } from './write.js';

const oddsMilli = (value: number): DecimalOddsMilli => {
  const result = decimalOddsMilli(value);
  if (!result.ok) {
    throw new Error(`bad odds ${value}`);
  }
  return result.value;
};

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

// One fixture: home shortens across three snapshots (steam, under-round book so the +EV
// path fires), then a final score that either backs or fades the home bet.
const fixtureEvents = (
  fixtureId: number,
  startSeq: number,
  baseTsMs: number,
  homeWins: boolean,
): FeedEvent[] => {
  const key = marketKey({
    fixtureId,
    superOddsType: 'StablePrice',
    marketPeriod: '0',
    marketParameters: '',
  });
  const odds = (seq: number, tsMs: number, home: number, draw: number, away: number): FeedEvent => ({
    kind: 'odds',
    envelope: {
      source: 'replay',
      seq,
      receivedAtMs: tsMs,
      payload: {
        fixtureId,
        messageId: `m${seq}`,
        tsMs,
        bookmakerId: 0,
        superOddsType: 'StablePrice',
        inRunning: false,
        marketKey: key,
        lines: [
          { outcome: 'home', decimalOddsMilli: oddsMilli(home), impliedPct: null },
          { outcome: 'draw', decimalOddsMilli: oddsMilli(draw), impliedPct: null },
          { outcome: 'away', decimalOddsMilli: oddsMilli(away), impliedPct: null },
        ],
      },
    },
  });
  const score = (seq: number, tsMs: number, home: number, away: number): FeedEvent => ({
    kind: 'score',
    envelope: {
      source: 'replay',
      seq,
      receivedAtMs: tsMs,
      payload: {
        fixtureId,
        seq,
        tsMs,
        gameState: 'F',
        participant1IsHome: true,
        homeGoals: home,
        awayGoals: away,
        stats: new Map<number, number>(),
      },
    },
  });
  const homeGoals = homeWins ? 2 : 0;
  const awayGoals = homeWins ? 1 : 2;
  return [
    odds(startSeq, baseTsMs, 2600, 3600, 3600),
    odds(startSeq + 1, baseTsMs + 60_000, 2300, 3800, 3800),
    odds(startSeq + 2, baseTsMs + 120_000, 2100, 4000, 4000),
    score(startSeq + 3, baseTsMs + 7_200_000, homeGoals, awayGoals),
  ];
};

// A winning home bet then a losing one, so the metrics, drawdown, and calibration are
// all non-trivial.
const scenario = (): readonly FeedEvent[] => [
  ...fixtureEvents(17588302, 0, 1_000, true),
  ...fixtureEvents(17588244, 10, 1_000_000, false),
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

describe('runBacktest', () => {
  it('produces hit rate, CLV, drawdown, and calibration over the settled bets', async () => {
    const run = await runBacktest(new ArrayFeed(scenario()), config);
    const metrics = run.metrics;

    expect(metrics.bets).toBe(2);
    expect(metrics.wins).toBe(1);
    expect(metrics.losses).toBe(1);
    expect(metrics.hitRate).toBeCloseTo(0.5, 10);
    // Both entries beat the close (the line kept shortening our way).
    expect(metrics.meanClvProb).toBeGreaterThan(0);
    expect(metrics.clvPositiveRate).toBeCloseTo(1, 10);
    // The winning bet peaks the equity, then the loss is the whole drawdown.
    expect(metrics.maxDrawdown).toBe(run.settlements[1]?.decision.stake);
    expect(metrics.totalPnl > 0n).toBe(true);
    expect(metrics.finalBankroll > config.startingBankroll).toBe(true);
    expect(metrics.calibration).not.toBeNull();
  });

  it('renders a deterministic markdown report', async () => {
    const first = renderMarkdownReport(await runBacktest(new ArrayFeed(scenario()), config));
    const second = renderMarkdownReport(await runBacktest(new ArrayFeed(scenario()), config));

    expect(first).toBe(second);
    expect(first).toContain('# Backtest report');
    expect(first).toContain('| Bets | 2 |');
    expect(first).toContain('| Hit rate | 50.00% |');
    expect(first).toContain('## Calibration');
  });

  it('renders a deterministic, self-contained HTML report with inline SVG', async () => {
    const run = await runBacktest(new ArrayFeed(scenario()), config);
    const first = renderHtmlReport(run);
    const second = renderHtmlReport(run);

    expect(first).toBe(second);
    expect(first).toContain('<!doctype html>');
    expect(first).toContain('<svg viewBox');
    // Self-contained: no external resources to fetch.
    expect(first).not.toContain('http://');
    expect(first).not.toContain('https://');
  });

  it('writes the markdown and HTML report files', async () => {
    const run = await runBacktest(new ArrayFeed(scenario()), config);
    const outDir = join(tmpdir(), 'txline-backtest-report-test');
    try {
      const written = await writeReportFiles(outDir, run);
      const markdown = await readFile(written.markdownPath, 'utf8');
      const html = await readFile(written.htmlPath, 'utf8');
      expect(markdown).toContain('# Backtest report');
      expect(html).toContain('<!doctype html>');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

describe('walkForward', () => {
  // A second config that never trades (its edge threshold is unreachable), so the tuner
  // must prefer the trading config on in-sample ROI.
  const idleConfig: PipelineConfig = {
    ...config,
    steam: { ...config.steam, minEdge: 0.5 },
    divergence: { ...config.divergence, minEdge: 0.5 },
  };

  it('tunes on in-sample and evaluates the chosen config out-of-sample', async () => {
    const result = await walkForward({
      inSample: () => new ArrayFeed(scenario()),
      outOfSample: () => new ArrayFeed(scenario()),
      grid: [idleConfig, config],
      score: (metrics) => metrics.roi,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.chosen).toBe(config);
    expect(result.value.inSample.bets).toBe(2);
    expect(result.value.outOfSample.bets).toBe(2);
  });

  it('rejects an empty grid', async () => {
    const result = await walkForward({
      inSample: () => new ArrayFeed(scenario()),
      outOfSample: () => new ArrayFeed(scenario()),
      grid: [],
      score: (metrics) => metrics.roi,
    });
    expect(result.ok).toBe(false);
  });
});
