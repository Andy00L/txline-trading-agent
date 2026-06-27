import {
  DEFAULT_CROSS_MARKET_CONFIG,
  microUsdSaturating,
  SeededPrng,
  type PipelineConfig,
} from '@txline-agent/core';
import { FetchHttpClient, TxlineClient, type IntervalCoord } from '@txline-agent/txline';

// Shared configuration for the cross-market backtest tools (single-window run and multi-window
// sweep), so both replay the exact same strategy and client. sourceRef: docs/BUILD_PLAN.md (M5).

// The tools run from tools/devnet, so the report lands at the repo-root backtest/out the README
// links to (not tools/devnet/backtest/out).
export const REPORT_OUT_DIR = '../../backtest/out';

export const requireEnvValue = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    console.error(`[backtest-config] missing required env ${key}`);
    process.exit(1);
  }
  return value;
};

export const intEnv = (key: string, fallback: number): number => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

export const floatEnv = (key: string, fallback: number): number => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Build the TxLINE client from the env credentials. */
export const buildClient = (): TxlineClient =>
  new TxlineClient(
    {
      http: new FetchHttpClient(),
      sleep: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
      prng: new SeededPrng(1),
      dataBaseUrl: requireEnvValue('TXLINE_DATA_BASE_URL'),
      authBaseUrl: requireEnvValue('TXLINE_AUTH_BASE_URL'),
    },
    { jwt: requireEnvValue('TXLINE_JWT'), apiToken: requireEnvValue('TXLINE_API_TOKEN') },
  );

/**
 * The cross-market relative-value strategy config: fit a goals model to each fixture's full
 * surface (1X2 + Over/Under) and back the 1X2 leg the joint fit prices longer than the 1X2 line,
 * sized by a real positive Kelly edge, gated to the near-kickoff window. The steam/divergence
 * config is retained but inert while crossMarket is set. sourceRef: docs/research/quant-methods.md.
 */
export const buildCrossMarketConfig = (): PipelineConfig => ({
  devigMethod: 'shin',
  steam: {
    windowMs: intEnv('STEAM_WINDOW_MS', 900_000),
    minProbMove: floatEnv('STEAM_MIN_PROB_MOVE', 0.01),
    minEdge: -1,
  },
  divergence: { minEdge: 1, minProb: 0.05, maxProb: 0.95 },
  decision: {
    kelly: {
      fraction: floatEnv('KELLY_FRACTION', 0.25),
      maxFractionOfBankroll: floatEnv('KELLY_MAX_FRACTION', 0.02),
    },
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
  // Keep the full pre-kickoff 1X2 history (the cross-market path records pre-match observations
  // only), so the entry and closing consensus both survive for the Closing Line Value measurement.
  steamHistoryLimit: intEnv('STEAM_HISTORY_LIMIT', 500),
  crossMarket: {
    ...DEFAULT_CROSS_MARKET_CONFIG,
    minEdge: floatEnv('CROSS_MIN_EDGE', DEFAULT_CROSS_MARKET_CONFIG.minEdge),
    minLeadMs: intEnv('CROSS_MIN_LEAD_MS', DEFAULT_CROSS_MARKET_CONFIG.minLeadMs),
    maxLeadMs: intEnv('CROSS_MAX_LEAD_MS', DEFAULT_CROSS_MARKET_CONFIG.maxLeadMs),
  },
});

/** Generate the interval coordinates for a window of spanHours from (startEpochDay, hourStart),
 * rolling across day boundaries so a fixture's full lifecycle is captured. */
export const windowIntervals = (
  startEpochDay: number,
  hourStart: number,
  spanHours: number,
): IntervalCoord[] => {
  const intervals: IntervalCoord[] = [];
  for (let hourOffset = 0; hourOffset < spanHours; hourOffset += 1) {
    const absoluteHour = hourStart + hourOffset;
    const epochDay = startEpochDay + Math.floor(absoluteHour / 24);
    const hourOfDay = absoluteHour % 24;
    for (let interval = 0; interval < 12; interval += 1) {
      intervals.push({ epochDay, hourOfDay, interval });
    }
  }
  return intervals;
};
