import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  err,
  ok,
  runPipeline,
  SeededPrng,
  type Clock,
  type PipelineConfig,
  type PipelineResult,
  type Prng,
  type Result,
} from '@txline-agent/core';
import {
  FetchHttpClient,
  FetchSseConnector,
  LiveSseFeed,
  SystemClock,
  TxlineClient,
  type IntervalCoord,
  type SseConnector,
} from '@txline-agent/txline';
import {
  addressToBytes,
  createDevnetPort,
  loadDevnetConfig,
  loadKeypairSigner,
} from '@txline-agent/onchain-client';
import { loadAgentConfig, type EnvRecord } from './config.js';
import { OnChainSink, type CommitSettlePort } from './onchain-sink.js';
import { AgentStateStore } from './state-store.js';
import { TappingFeed } from './tapping-feed.js';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const INTERVALS_PER_HOUR = 12; // odds/scores roots publish every 5 minutes -> 12 per hour

const sleep = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

/**
 * On reconnect, refetch the 12 intervals of the hour the last event fell in, so the REST
 * backfill closes the gap the dropped stream left (idempotency dedupes the overlap).
 * sourceRef: docs/BUILD_PLAN.md (replay-on-reconnect backfill).
 */
const backfillIntervalsFromTs = (lastTsMs: number): readonly IntervalCoord[] => {
  if (lastTsMs <= 0) {
    return [];
  }
  const epochDay = Math.floor(lastTsMs / MS_PER_DAY);
  const hourOfDay = Math.floor((lastTsMs % MS_PER_DAY) / MS_PER_HOUR);
  const intervals: IntervalCoord[] = [];
  for (let interval = 0; interval < INTERVALS_PER_HOUR; interval += 1) {
    intervals.push({ epochDay, hourOfDay, interval });
  }
  return intervals;
};

export type AgentRuntime = {
  readonly store: AgentStateStore;
  /** Start the pipeline (idempotent). Runs in the background; observe progress via the store. */
  start(): void;
  /** Request an orderly stop and resolve with the run totals. */
  stop(): Promise<PipelineResult>;
};

export type CreateAgentRuntimeDeps = {
  readonly client: TxlineClient; // backfill (feed) and stat-validation proofs (sink)
  readonly connector: SseConnector;
  readonly port: CommitSettlePort;
  readonly store: AgentStateStore;
  readonly strategyBytes: Uint8Array;
  readonly pipelineConfig: PipelineConfig;
  readonly clock: Clock;
  readonly prng: Prng;
  readonly sleep: (durationMs: number) => Promise<void>;
  readonly maxReconnects: number;
  readonly nextNonce: () => Uint8Array;
  readonly backfillIntervals: (lastTsMs: number) => readonly IntervalCoord[];
  readonly log: (message: string) => void;
};

/** Wire the live feed, the tap, and the on-chain sink into a runnable pipeline. Pure wiring:
 * it does no IO until start() drives the feed. */
export const createAgentRuntime = (deps: CreateAgentRuntimeDeps): AgentRuntime => {
  const feed = new LiveSseFeed({
    connector: deps.connector,
    client: deps.client,
    clock: deps.clock,
    prng: deps.prng,
    sleep: deps.sleep,
    maxReconnects: deps.maxReconnects,
    backfillIntervals: deps.backfillIntervals,
  });
  const tappingFeed = new TappingFeed(feed, deps.store);
  const sink = new OnChainSink({
    port: deps.port,
    proofs: deps.client,
    // Same client drives the third trust link: scan the odds feed for the sealed entry record and
    // fetch its Merkle proof, so the live agent proves entry odds (validate_odds) after each settle.
    oddsProofs: deps.client,
    store: deps.store,
    strategyBytes: deps.strategyBytes,
    nextNonce: deps.nextNonce,
    log: deps.log,
  });
  let run: Promise<PipelineResult> | null = null;
  return {
    store: deps.store,
    start: () => {
      if (run === null) {
        run = runPipeline(tappingFeed, sink, deps.pipelineConfig).catch((error: unknown) => {
          // A rejecting pipeline must not become an unobserved rejection that crashes the
          // process; record it and resolve to a terminal result so stop() stays clean.
          const detail = error instanceof Error ? error.message : String(error);
          deps.store.recordError('pipeline', detail);
          deps.log(`[createAgentRuntime] pipeline failed: ${detail}`);
          return {
            committed: 0,
            settled: 0,
            finalBankroll: deps.pipelineConfig.startingBankroll,
            eventsProcessed: 0,
          };
        });
      }
    },
    stop: async () => {
      await feed.stop();
      if (run === null) {
        return {
          committed: 0,
          settled: 0,
          finalBankroll: deps.pipelineConfig.startingBankroll,
          eventsProcessed: 0,
        };
      }
      return run;
    },
  };
};

export type BootstrapResult = { readonly runtime: AgentRuntime; readonly apiPort: number };

/**
 * Build a live AgentRuntime from environment variables: load the agent and devnet configs,
 * load the authority keypair, create the live Solana port, ensure the strategy ledger exists
 * (initializing it on first run, pinning the txoracle program), then wire the TxLINE client,
 * SSE connector, state store, and pipeline. Errors are returned as a value so the caller can
 * print a clear message and exit. sourceRef: tools/devnet/src/settle-e2e.ts (bootstrap shape).
 */
export const bootstrapAgentRuntime = async (
  env: EnvRecord,
): Promise<Result<BootstrapResult, string>> => {
  const agentConfig = loadAgentConfig(env);
  if (!agentConfig.ok) {
    return err(`agent config: ${agentConfig.error.field} ${agentConfig.error.detail}`);
  }
  const devnetConfig = loadDevnetConfig(env);
  if (!devnetConfig.ok) {
    return err(`devnet config: ${devnetConfig.error.field} ${devnetConfig.error.detail}`);
  }
  const signer = await loadKeypairSigner(
    (path) => readFile(path, 'utf8'),
    devnetConfig.value.keypairPath,
  );
  if (!signer.ok) {
    return err(`keypair: ${signer.error.field} ${signer.error.detail}`);
  }
  const port = createDevnetPort(devnetConfig.value, signer.value);

  const existing = await port.readStrategy();
  if (!existing.ok) {
    return err(`readStrategy: ${existing.error.kind} ${existing.error.detail}`);
  }
  if (existing.value === null) {
    const initialized = await port.initializeStrategy(agentConfig.value.pipeline.startingBankroll);
    if (!initialized.ok) {
      return err(`initializeStrategy: ${initialized.error.kind} ${initialized.error.detail}`);
    }
  }
  const strategyBytes = addressToBytes(await port.strategyAddress());

  const clock = new SystemClock();
  const connection = agentConfig.value.txline;
  const client = new TxlineClient(
    {
      http: new FetchHttpClient(),
      sleep,
      prng: new SeededPrng(1),
      dataBaseUrl: connection.dataBaseUrl,
      authBaseUrl: connection.authBaseUrl,
    },
    { jwt: connection.jwt, apiToken: connection.apiToken },
  );
  const connector = new FetchSseConnector({
    dataBaseUrl: connection.dataBaseUrl,
    auth: { jwt: connection.jwt, apiToken: connection.apiToken },
  });
  const store = new AgentStateStore({
    clock,
    startingBankroll: agentConfig.value.pipeline.startingBankroll,
  });

  const runtime = createAgentRuntime({
    client,
    connector,
    port,
    store,
    strategyBytes,
    pipelineConfig: agentConfig.value.pipeline,
    clock,
    prng: new SeededPrng(2),
    sleep,
    maxReconnects: agentConfig.value.maxReconnects ?? Number.POSITIVE_INFINITY,
    nextNonce: () => new Uint8Array(randomBytes(32)),
    backfillIntervals: backfillIntervalsFromTs,
    log: (message) => console.log(message),
  });
  return ok({ runtime, apiPort: agentConfig.value.apiPort });
};
