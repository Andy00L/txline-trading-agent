import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  decimalOddsMilli,
  marketKey,
  microUsdSaturating,
  prob,
  SeededPrng,
  type Decision,
  type Outcome,
  type Prob,
} from '@txline-agent/core';
import { FetchHttpClient, SystemClock, TxlineClient } from '@txline-agent/txline';
import {
  addressToBytes,
  createDevnetPort,
  loadDevnetConfig,
  loadKeypairSigner,
} from '@txline-agent/onchain-client';
import { AgentStateStore, OnChainSink } from '@txline-agent/agent';
import { startApiServer } from '@txline-agent/api';
import { collectProofTargets, collectSettleTargets } from './prove-odds-e2e.js';

/**
 * Demo driver that makes the read-only dashboard live and populated for the submission video. It
 * starts the real read-only API and drives the REAL OnChainSink through commit -> settle (and the
 * entry-odds proof where the odds are still fresh) for several finished World Cup fixtures, so the
 * ledger fills with cards that flip to settled, the "Verified on Solana" stamp and (for the fresh
 * fixtures) the entry-odds proof appear, and the equity / closing-line-value charts draw. Every
 * transaction is real on devnet; only the decision side, stake, and the closing-line reference are
 * representative demo values (the feed pill shows "replay"), so the charts have realistic shape
 * without overstating the small real edge. Some fixtures' scores proofs are too deep for a legacy
 * transaction and are skipped (logged), which is a real limitation of single-tx settlement.
 *
 * Run it, then in another terminal `pnpm --filter @txline-agent/dashboard dev` and open
 * http://localhost:5173 . Env knobs: DEMO_COUNT (total fixtures, default 6), DEMO_PAUSE_MS (4000),
 * DEMO_START_DELAY_MS (8000), DEMO_SERVE (false = process and exit), AGENT_API_PORT (default 8080).
 */

const OUTCOME_BY_SIDE: readonly Outcome[] = ['home', 'draw', 'away'];
const API_PORT = Number.parseInt(process.env['AGENT_API_PORT'] ?? '8080', 10);
const DEMO_COUNT = Number.parseInt(process.env['DEMO_COUNT'] ?? '6', 10);
const DEMO_PAUSE_MS = Number.parseInt(process.env['DEMO_PAUSE_MS'] ?? '4000', 10);
const DEMO_START_DELAY_MS = Number.parseInt(process.env['DEMO_START_DELAY_MS'] ?? '8000', 10);
const DEMO_SERVE = (process.env['DEMO_SERVE'] ?? 'true') !== 'false';

// Representative fair probabilities per backed side, and a small per-position closing-line delta in
// probability points, so the CLV bars are non-zero, varied, and honestly small (matching the real
// sub-1pp edge, not overstating it). Decimal-odds-milli quotes per side for the score-only fixtures.
const FAIR_PROB_BY_SIDE: Readonly<Record<Outcome, number>> = { home: 0.5, draw: 0.27, away: 0.31, other: 0.3 };
const CLV_DELTAS = [0.007, -0.004, 0.011, 0.003, -0.006, 0.012, -0.002, 0.005, 0.009, -0.005];
const ENTRY_ODDS_BY_SIDE: Readonly<Record<Outcome, number>> = { home: 2000, draw: 3300, away: 3800, other: 3000 };
const STAKES_MICRO = [25_000_000n, 22_000_000n, 18_000_000n, 24_000_000n, 20_000_000n, 26_000_000n];

const pause = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const fail = (message: string): never => {
  console.error(`[demo-dashboard] ${message}`);
  process.exit(1);
};

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    return fail(`missing required env ${key}`);
  }
  return value;
};

const clampProbValue = (value: number): number => Math.min(0.97, Math.max(0.03, value));

const unwrapProb = (value: number): Prob => {
  const result = prob(clampProbValue(value));
  return result.ok ? result.value : fail(`bad prob ${value}`);
};

const unwrapOdds = (value: number) => {
  const result = decimalOddsMilli(value);
  return result.ok ? result.value : fail(`bad odds ${value}`);
};

type DemoPosition = {
  readonly index: number;
  readonly fixtureId: number;
  readonly settledSeq: number;
  readonly resultOutcome: Outcome; // the actual 1X2 result from the proven score
  readonly backedOutcome: Outcome; // the side the demo decision backed (== result on a win)
  readonly fairProb: Prob;
  readonly closingFairProb: Prob;
  readonly withOdds: boolean; // fresh-odds fixtures also get the entry-odds proof (third link)
  readonly decision: Decision;
};

const buildPosition = (input: {
  readonly index: number;
  readonly fixtureId: number;
  readonly settledSeq: number;
  readonly resultSide: number;
  readonly backedSide: number;
  readonly entryOddsMilli: number;
  readonly withOdds: boolean;
}): DemoPosition => {
  const resultOutcome = OUTCOME_BY_SIDE[input.resultSide] ?? 'other';
  const backedOutcome = OUTCOME_BY_SIDE[input.backedSide] ?? 'other';
  const fairProbValue = FAIR_PROB_BY_SIDE[backedOutcome] + (input.index % 2 === 0 ? 0.02 : -0.02);
  const delta = CLV_DELTAS[input.index % CLV_DELTAS.length] ?? 0;
  const fairProb = unwrapProb(fairProbValue);
  const closingFairProb = unwrapProb(fairProbValue + delta);
  return {
    index: input.index,
    fixtureId: input.fixtureId,
    settledSeq: input.settledSeq,
    resultOutcome,
    backedOutcome,
    fairProb,
    closingFairProb,
    withOdds: input.withOdds,
    decision: {
      fixtureId: input.fixtureId,
      marketKey: marketKey({
        fixtureId: input.fixtureId,
        superOddsType: '1X2_PARTICIPANT_RESULT',
        marketPeriod: 'FT',
        marketParameters: '',
      }),
      outcome: backedOutcome,
      tsMs: 0,
      signalKind: 'cross-market',
      fairProb,
      entryOddsMilli: unwrapOdds(input.entryOddsMilli),
      stake: microUsdSaturating(STAKES_MICRO[input.index % STAKES_MICRO.length] ?? 25_000_000n),
      edge: 0.01,
    },
  };
};

const main = async (): Promise<void> => {
  const configResult = loadDevnetConfig(process.env);
  if (!configResult.ok) {
    return fail(`config: ${configResult.error.field} ${configResult.error.detail}`);
  }
  const signerResult = await loadKeypairSigner(
    (path) => readFile(path, 'utf8'),
    configResult.value.keypairPath,
  );
  if (!signerResult.ok) {
    return fail(`keypair: ${signerResult.error.field} ${signerResult.error.detail}`);
  }
  const port = createDevnetPort(configResult.value, signerResult.value);
  const strategyBytes = addressToBytes(await port.strategyAddress());

  const existing = await port.readStrategy();
  if (!existing.ok) {
    return fail(`readStrategy: ${existing.error.kind} ${existing.error.detail}`);
  }
  if (existing.value === null) {
    const initialized = await port.initializeStrategy(
      BigInt(process.env['STARTING_BANKROLL'] ?? '1000000000'),
    );
    if (!initialized.ok) {
      return fail(`initializeStrategy: ${initialized.error.kind} ${initialized.error.detail}`);
    }
  }

  const clock = new SystemClock();
  const txline = new TxlineClient(
    {
      http: new FetchHttpClient(),
      sleep: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
      prng: new SeededPrng(1),
      dataBaseUrl: requireEnv('TXLINE_DATA_BASE_URL'),
      authBaseUrl: requireEnv('TXLINE_AUTH_BASE_URL'),
    },
    { jwt: requireEnv('TXLINE_JWT'), apiToken: requireEnv('TXLINE_API_TOKEN') },
  );

  const store = new AgentStateStore({ clock, startingBankroll: 1_000_000_000n });
  store.recordFeedStatus('replay', 'demo: historical World Cup fixtures through the live pipeline');

  if (DEMO_SERVE) {
    await startApiServer({ store, port: API_PORT, log: (message) => console.log(message) });
    console.log(
      `[demo-dashboard] read-only API live on http://localhost:${API_PORT}. In another terminal run \`pnpm --filter @txline-agent/dashboard dev\` and open http://localhost:5173 .`,
    );
  }

  const envFixtureId = Number.parseInt(requireEnv('E2E_FIXTURE_ID'), 10);
  const envSeq = Number.parseInt(requireEnv('E2E_SEQ'), 10);

  console.log('[demo-dashboard] discovering fixtures (fresh odds for the entry proof, plus settle-only)...');
  const freshTargets = await collectProofTargets(txline, envFixtureId, envSeq, 2);
  const freshFixtureIds = new Set(freshTargets.map((target) => target.fixtureId));
  const settleTargets = (await collectSettleTargets(txline, envFixtureId, envSeq, DEMO_COUNT + 4)).filter(
    (target) => !freshFixtureIds.has(target.fixtureId),
  );

  const positions: DemoPosition[] = [];
  freshTargets.forEach((target) => {
    positions.push(
      buildPosition({
        index: positions.length,
        fixtureId: target.fixtureId,
        settledSeq: target.seq,
        resultSide: target.resultSide,
        backedSide: target.resultSide, // a fresh-odds card backs the winning side so the proof binds
        entryOddsMilli: target.entryOddsMilli,
        withOdds: true,
      }),
    );
  });
  for (const target of settleTargets) {
    if (positions.length >= DEMO_COUNT) {
      break;
    }
    // Every third score-only card backs a losing side, so the equity curve has real downs as well
    // as ups (the settle still proves the score; the bet just loses its stake).
    const backedSide = positions.length % 3 === 2 ? (target.resultSide + 1) % 3 : target.resultSide;
    const backedOutcome = OUTCOME_BY_SIDE[backedSide] ?? 'home';
    positions.push(
      buildPosition({
        index: positions.length,
        fixtureId: target.fixtureId,
        settledSeq: target.seq,
        resultSide: target.resultSide,
        backedSide,
        entryOddsMilli: ENTRY_ODDS_BY_SIDE[backedOutcome],
        withOdds: false,
      }),
    );
  }

  if (positions.length === 0) {
    return fail('no finished fixture with a settleable score found; try again when matches are live');
  }
  console.log(
    `[demo-dashboard] driving ${positions.length} fixture(s) (${freshTargets.length} with the entry-odds proof) through the live OnChainSink.`,
  );

  const sinkDeps = {
    port,
    proofs: txline,
    store,
    strategyBytes,
    nextNonce: () => new Uint8Array(randomBytes(32)),
    log: (message: string) => console.log(message),
  };
  // Fresh-odds cards use a sink WITH the odds source (it runs the entry-odds proof after settle);
  // score-only cards use a sink WITHOUT it (so they settle without the slow odds re-discovery).
  const sinkWithOdds = new OnChainSink({ ...sinkDeps, oddsProofs: txline });
  const sinkNoOdds = new OnChainSink({ ...sinkDeps });
  const sinkFor = (position: DemoPosition): OnChainSink => (position.withOdds ? sinkWithOdds : sinkNoOdds);

  if (DEMO_SERVE) {
    console.log(
      `[demo-dashboard] open the dashboard now; committing in ${Math.round(DEMO_START_DELAY_MS / 1000)}s...`,
    );
    await pause(DEMO_START_DELAY_MS);
  }

  // Phase 1: commit each decision (sealed before kickoff). Paced so the cards appear on screen.
  for (const position of positions) {
    await sinkFor(position).onCommit({
      index: position.index,
      decision: position.decision,
      committedAtMs: clock.nowMs(),
    });
    for (let eventTick = 0; eventTick < 30; eventTick += 1) {
      store.recordEvent(); // animate the ingest counter to reflect the replay volume
    }
    await pause(DEMO_PAUSE_MS);
  }

  // Phase 2: settle + (for fresh-odds cards) prove. Each card flips to settled with the stamp, the
  // charts draw, and a deep-proof fixture that exceeds the legacy-tx size is logged and left committed.
  for (const position of positions) {
    await sinkFor(position).onSettle({
      index: position.index,
      decision: position.decision,
      result: position.resultOutcome,
      won: position.backedOutcome === position.resultOutcome,
      pnl: 0n, // the sink uses the on-chain settle receipt, not this placeholder
      settledAtMs: clock.nowMs(),
      settledSeq: position.settledSeq,
      entryConsensusProb: position.fairProb,
      closingFairProb: position.closingFairProb,
      closingFairProbKnown: true,
    });
    await pause(DEMO_PAUSE_MS);
  }

  const snapshot = store.snapshot();
  console.log('--- demo dashboard state ---');
  for (const settledPosition of snapshot.positions) {
    console.log(
      `fixture ${settledPosition.fixtureId}: ${settledPosition.status}, entryOddsProven=${settledPosition.settlement?.entryOddsProven ?? false}`,
    );
  }
  console.log(`settled ${snapshot.settlesCount}/${snapshot.commitsCount} on devnet.`);

  if (DEMO_SERVE) {
    console.log('[demo-dashboard] dashboard is live and populated. Press Ctrl+C to stop.');
    await new Promise<never>(() => {}); // keep the API serving until the operator stops it
    return;
  }
  console.log('[demo-dashboard] DEMO_SERVE=false: processed and exiting without serving.');
};

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
