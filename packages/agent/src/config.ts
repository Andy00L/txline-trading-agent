import {
  err,
  microUsdSaturating,
  ok,
  type PipelineConfig,
  type Result,
} from '@txline-agent/core';

/**
 * Agent configuration from environment variables (errors as values). The strategy
 * parameters mirror tools/devnet backtest-run defaults, so the live agent runs the same
 * config the walk-forward backtest validates: steam is sized CLV-first (the de-margined
 * StablePrice gives Kelly no entry edge) and divergence is effectively disabled (its +EV
 * second line is not in the free tier). The Solana/devnet side is loaded separately by
 * onchain-client loadDevnetConfig. sourceRef: tools/devnet/src/backtest-run.ts, docs/DECISIONS.md.
 */

export type AgentConfigError = {
  readonly kind: 'missing-env' | 'bad-env';
  readonly field: string;
  readonly detail: string;
};

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export type TxlineConnection = {
  readonly dataBaseUrl: string;
  readonly authBaseUrl: string;
  readonly jwt: string;
  readonly apiToken: string;
};

export type AgentConfig = {
  readonly txline: TxlineConnection;
  readonly pipeline: PipelineConfig;
  readonly apiPort: number;
  /** Bounded reconnect attempts, or null for unbounded (the live default). */
  readonly maxReconnects: number | null;
};

const requireEnv = (env: EnvRecord, field: string): Result<string, AgentConfigError> => {
  const value = env[field];
  if (value === undefined || value.length === 0) {
    return err({ kind: 'missing-env', field, detail: `${field} is required` });
  }
  return ok(value);
};

const intEnv = (env: EnvRecord, field: string, fallback: number): number => {
  const value = env[field];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const floatEnv = (env: EnvRecord, field: string, fallback: number): number => {
  const value = env[field];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bigintEnv = (env: EnvRecord, field: string, fallback: bigint): bigint => {
  const value = env[field];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
};

const buildPipelineConfig = (env: EnvRecord): PipelineConfig => ({
  devigMethod: 'multiplicative',
  steam: {
    windowMs: intEnv(env, 'STEAM_WINDOW_MS', 900_000),
    minProbMove: floatEnv(env, 'STEAM_MIN_PROB_MOVE', 0.01),
    minEdge: -1, // steam is sized by move strength, not gated on entry EV (de-margined book)
  },
  divergence: { minEdge: 1, minProb: 0.05, maxProb: 0.95 }, // minEdge 1 effectively disables it
  decision: {
    kelly: { fraction: 0.25, maxFractionOfBankroll: 0.02 },
    risk: {
      bankrollFloor: microUsdSaturating(0n),
      maxStakePerOrder: microUsdSaturating(bigintEnv(env, 'MAX_STAKE_MICRO_USD', 50_000_000n)),
      maxConcurrent: intEnv(env, 'MAX_CONCURRENT', 200),
      totalExposureCap: microUsdSaturating(2_000_000_000n),
      perFixtureExposureCap: microUsdSaturating(100_000_000n),
      perMarketExposureCap: microUsdSaturating(100_000_000n),
      staleFeedMs: intEnv(env, 'STALE_FEED_MS', 86_400_000),
      outlierOddsZ: 100,
      maxDailyDrawdown: microUsdSaturating(1_000_000_000n),
    },
    steamSizing: {
      baseFraction: floatEnv(env, 'STEAM_BASE_FRACTION', 0.005),
      strengthScale: floatEnv(env, 'STEAM_STRENGTH_SCALE', 0.5),
      maxFraction: floatEnv(env, 'STEAM_MAX_FRACTION', 0.02),
    },
  },
  startingBankroll: microUsdSaturating(bigintEnv(env, 'STARTING_BANKROLL', 1_000_000_000n)),
  steamHistoryLimit: intEnv(env, 'STEAM_HISTORY_LIMIT', 100),
});

/** Build the agent config from environment variables. The four TxLINE connection fields are
 * required; everything else has a sane default matching the validated backtest config. */
export const loadAgentConfig = (env: EnvRecord): Result<AgentConfig, AgentConfigError> => {
  const dataBaseUrl = requireEnv(env, 'TXLINE_DATA_BASE_URL');
  if (!dataBaseUrl.ok) {
    return dataBaseUrl;
  }
  const authBaseUrl = requireEnv(env, 'TXLINE_AUTH_BASE_URL');
  if (!authBaseUrl.ok) {
    return authBaseUrl;
  }
  const jwt = requireEnv(env, 'TXLINE_JWT');
  if (!jwt.ok) {
    return jwt;
  }
  const apiToken = requireEnv(env, 'TXLINE_API_TOKEN');
  if (!apiToken.ok) {
    return apiToken;
  }
  const maxReconnects = intEnv(env, 'AGENT_MAX_RECONNECTS', 0);
  return ok({
    txline: {
      dataBaseUrl: dataBaseUrl.value,
      authBaseUrl: authBaseUrl.value,
      jwt: jwt.value,
      apiToken: apiToken.value,
    },
    pipeline: buildPipelineConfig(env),
    apiPort: intEnv(env, 'API_PORT', 8080),
    maxReconnects: maxReconnects > 0 ? maxReconnects : null,
  });
};
