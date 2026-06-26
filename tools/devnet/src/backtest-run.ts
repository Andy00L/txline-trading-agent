import { microUsdSaturating, SeededPrng, type PipelineConfig } from '@txline-agent/core';
import { replayBacktest, writeReportFiles } from '@txline-agent/backtest';
import {
  ClientReplaySource,
  FetchHttpClient,
  TxlineClient,
  type IntervalCoord,
} from '@txline-agent/txline';

// Run the backtest over a real captured World Cup window. The CLV-first config sizes steam
// signals by move strength (the de-margined StablePrice gives Kelly no entry edge), and
// divergence is effectively disabled (it needs a +EV second line that the free tier lacks).
// Needs TXLINE_* in .env. sourceRef: docs/runbooks/M4-devnet.md (token), docs/BUILD_PLAN.md (M5).

const requireEnvValue = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    console.error(`[backtest-run] missing required env ${key}`);
    process.exit(1);
  }
  return value;
};

const intEnv = (key: string, fallback: number): number => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const floatEnv = (key: string, fallback: number): number => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const main = async (): Promise<void> => {
  const epochDay = intEnv('BACKTEST_EPOCH_DAY', 20629);
  const hourStart = intEnv('BACKTEST_HOUR_START', 18);
  const hourEnd = intEnv('BACKTEST_HOUR_END', 23);

  const intervals: IntervalCoord[] = [];
  for (let hour = hourStart; hour <= hourEnd; hour += 1) {
    for (let interval = 0; interval < 12; interval += 1) {
      intervals.push({ epochDay, hourOfDay: hour, interval });
    }
  }

  const client = new TxlineClient(
    {
      http: new FetchHttpClient(),
      sleep: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
      prng: new SeededPrng(1),
      dataBaseUrl: requireEnvValue('TXLINE_DATA_BASE_URL'),
      authBaseUrl: requireEnvValue('TXLINE_AUTH_BASE_URL'),
    },
    { jwt: requireEnvValue('TXLINE_JWT'), apiToken: requireEnvValue('TXLINE_API_TOKEN') },
  );

  const config: PipelineConfig = {
    devigMethod: 'multiplicative',
    steam: {
      windowMs: intEnv('STEAM_WINDOW_MS', 900_000),
      minProbMove: floatEnv('STEAM_MIN_PROB_MOVE', 0.01),
      minEdge: -1,
    },
    divergence: { minEdge: 1, minProb: 0.05, maxProb: 0.95 },
    decision: {
      kelly: { fraction: 0.25, maxFractionOfBankroll: 0.02 },
      risk: {
        bankrollFloor: microUsdSaturating(0n),
        maxStakePerOrder: microUsdSaturating(50_000_000n),
        maxConcurrent: 200,
        totalExposureCap: microUsdSaturating(2_000_000_000n),
        perFixtureExposureCap: microUsdSaturating(100_000_000n),
        perMarketExposureCap: microUsdSaturating(100_000_000n),
        staleFeedMs: 86_400_000,
        outlierOddsZ: 100,
        maxDailyDrawdown: microUsdSaturating(1_000_000_000n),
      },
      steamSizing: { baseFraction: 0.005, strengthScale: 0.5, maxFraction: 0.02 },
    },
    startingBankroll: microUsdSaturating(1_000_000_000n),
    steamHistoryLimit: intEnv('STEAM_HISTORY_LIMIT', 100),
  };

  const startMs = epochDay * 86_400_000 + hourStart * 3_600_000;
  console.log(
    `[backtest-run] replaying epochDay ${epochDay} hours ${hourStart}-${hourEnd} (${intervals.length} intervals)`,
  );
  const run = await replayBacktest({ source: new ClientReplaySource(client), intervals, startMs, config });
  const written = await writeReportFiles('backtest/out', run);
  const metrics = run.metrics;
  console.log(
    `[backtest-run] events ${run.result.eventsProcessed}, committed ${run.result.committed}, settled ${run.result.settled}, bets ${metrics.bets}, wins ${metrics.wins}/${metrics.losses}, hitRate ${(metrics.hitRate * 100).toFixed(1)}%, meanCLV ${metrics.meanClvProb.toFixed(4)}, ROI ${(metrics.roi * 100).toFixed(2)}%, finalBankroll ${(Number(metrics.finalBankroll) / 1_000_000).toFixed(2)} USDC`,
  );
  console.log(`[backtest-run] wrote ${written.markdownPath} and ${written.htmlPath}`);
};

main().catch((error: unknown) => {
  console.error(`[backtest-run] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
