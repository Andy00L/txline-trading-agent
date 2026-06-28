import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  decimalOddsMilli,
  marketKey,
  microUsdSaturating,
  prob,
  SeededPrng,
  type CommittedPosition,
  type Decision,
  type Outcome,
  type SettledPosition,
} from '@txline-agent/core';
import { FetchHttpClient, SystemClock, TxlineClient } from '@txline-agent/txline';
import {
  addressToBytes,
  createDevnetPort,
  loadDevnetConfig,
  loadKeypairSigner,
} from '@txline-agent/onchain-client';
import { AgentStateStore, OnChainSink } from '@txline-agent/agent';
import { selectProofTarget } from './prove-odds-e2e.js';

/**
 * Observe the THIRD trust link in production: drive the real live OnChainSink (the exact code the
 * agent runs, not a unit-test fake) end to end on devnet for a finished World Cup fixture. It
 * commits a decision, settles it by CPI into validate_stat, then the sink's post-settle hook
 * re-discovers the sealed entry odds record and proves it by CPI into validate_odds. Confirms all
 * three transactions land and the store records entry_odds_proven. Reuses selectProofTarget from
 * prove-odds-e2e.ts (a fixture with both a settleable score and a fresh 1X2 odds proof).
 *
 * This is the live-feed observation the unit tests cannot give: the sink orchestration, the real
 * Solana port, and the real TxLINE odds re-discovery, against a genuine published fixture.
 */

const OUTCOME_BY_SIDE: readonly Outcome[] = ['home', 'draw', 'away'];

const fail = (message: string): never => {
  console.error(`[prove-odds-live] ${message}`);
  process.exit(1);
};

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    return fail(`missing required env ${key}`);
  }
  return value;
};

const unwrapProb = (value: number) => {
  const result = prob(value);
  return result.ok ? result.value : fail(`bad prob ${value}`);
};

const unwrapOdds = (value: number) => {
  const result = decimalOddsMilli(value);
  return result.ok ? result.value : fail(`bad odds ${value}`);
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
    console.log(`[prove-odds-live] initialized strategy: ${initialized.value.txSig}`);
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

  const target = await selectProofTarget(
    txline,
    Number.parseInt(requireEnv('E2E_FIXTURE_ID'), 10),
    Number.parseInt(requireEnv('E2E_SEQ'), 10),
  );
  const outcome = OUTCOME_BY_SIDE[target.resultSide];
  if (outcome === undefined) {
    return fail(`unexpected result side ${target.resultSide}`);
  }
  console.log(
    `[prove-odds-live] target fixture ${target.fixtureId} seq ${target.seq}: result side ${target.resultSide} (${outcome}), sealed entry odds ${target.entryOddsMilli}`,
  );

  // The decision the live sink would have produced: back the side the score will prove, at the
  // published 1X2 price for that side, so the settle wins and the entry-odds proof can bind.
  const decision: Decision = {
    fixtureId: target.fixtureId,
    marketKey: marketKey({
      fixtureId: target.fixtureId,
      superOddsType: '1X2_PARTICIPANT_RESULT',
      marketPeriod: 'FT',
      marketParameters: '',
    }),
    outcome,
    tsMs: target.oddsValidation.odds.Ts,
    signalKind: 'cross-market',
    fairProb: unwrapProb(0.5),
    entryOddsMilli: unwrapOdds(target.entryOddsMilli),
    stake: microUsdSaturating(25_000_000n),
    edge: 0,
  };

  const store = new AgentStateStore({ clock, startingBankroll: 1_000_000_000n });
  // Wire the sink exactly as the live runtime does: oddsProofs = the same client, so the third
  // trust link runs after the settle. sourceRef: packages/agent/src/runtime.ts.
  const sink = new OnChainSink({
    port,
    proofs: txline,
    oddsProofs: txline,
    store,
    strategyBytes,
    nextNonce: () => new Uint8Array(randomBytes(32)),
    log: (message) => console.log(message),
  });

  const committedPosition: CommittedPosition = { index: 0, decision, committedAtMs: clock.nowMs() };
  await sink.onCommit(committedPosition);

  const settledPosition: SettledPosition = {
    index: 0,
    decision,
    result: outcome,
    won: true,
    pnl: 0n, // the sink uses the on-chain settle receipt, not this placeholder
    settledAtMs: clock.nowMs(),
    settledSeq: target.seq,
    entryConsensusProb: unwrapProb(0.5),
    closingFairProb: unwrapProb(0.5),
    closingFairProbKnown: false,
  };
  await sink.onSettle(settledPosition);

  const snapshot = store.snapshot();
  const position = snapshot.positions[0];
  console.log('--- live OnChainSink result ---');
  console.log(`commit tx:        ${position?.explorerUrl ?? '(none)'}`);
  console.log(`settle tx:        ${position?.settlement?.explorerUrl ?? '(none)'}`);
  console.log(`entryOddsProven:  ${position?.settlement?.entryOddsProven ?? false}`);
  console.log(`odds-proof tx:    ${position?.settlement?.oddsProofExplorerUrl ?? '(none)'}`);
  if (snapshot.recentErrors.length > 0) {
    console.log(`recent errors:    ${JSON.stringify(snapshot.recentErrors)}`);
  }
  if (position?.settlement?.entryOddsProven !== true) {
    return fail(
      'the third link did NOT land (entryOddsProven is not true). If the entry odds record aged out of the validation window the sink skips by design; re-run when a fresh fixture is available.',
    );
  }
  console.log(
    '[prove-odds-live] SUCCESS: commit -> settle (validate_stat) -> entry-odds proof (validate_odds) all landed on devnet via the live OnChainSink.',
  );
};

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
