import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SeededPrng } from '@txline-agent/core';
import { FetchHttpClient, TxlineClient } from '@txline-agent/txline';
import {
  addressToBytes,
  buildSettleArgs,
  computeCommitHash,
  createDevnetPort,
  loadDevnetConfig,
  loadKeypairSigner,
  type RevealArgs,
  type SettleArgsInput,
  type SolanaOnChainPort,
} from '@txline-agent/onchain-client';

// 1X2 sides, mirroring programs/agent_ledger/src/state.rs SIDE_* and the off-chain Outcome.
const SIDE_HOME = 0;
const SIDE_DRAW = 1;
const SIDE_AWAY = 2;
const MARKET_1X2 = 0;

// The env keys the live run needs. Without all of them the script skips cleanly, so it is
// safe to invoke in CI or before the wallet and token exist.
const REQUIRED_ENV = [
  'SOLANA_RPC_URL',
  'AGENT_KEYPAIR_PATH',
  'TXORACLE_PROGRAM_ID',
  'TXLINE_DATA_BASE_URL',
  'TXLINE_AUTH_BASE_URL',
  'TXLINE_JWT',
  'TXLINE_API_TOKEN',
  'E2E_FIXTURE_ID',
  'E2E_SEQ',
];

const explorerTx = (signature: string): string =>
  `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

const sha256Bytes = (text: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(text).digest());

const requireEnvValue = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    console.error(`[settle-e2e] missing required env ${key}`);
    process.exit(1);
  }
  return value;
};

const fail = (message: string): never => {
  console.error(`[settle-e2e] ${message}`);
  process.exit(1);
};

// Flip one byte of the home stat's event root so the validate_stat CPI must reject it.
const tamperSettleArgs = (args: SettleArgsInput): SettleArgsInput => {
  const corruptedRoot = new Uint8Array(args.statHome.eventStatRoot);
  const firstByte = corruptedRoot[0] ?? 0;
  corruptedRoot[0] = firstByte ^ 0xff;
  return { ...args, statHome: { ...args.statHome, eventStatRoot: corruptedRoot } };
};

const buildReveal = (input: {
  readonly strategyBytes: Uint8Array;
  readonly index: bigint;
  readonly fixtureId: number;
  readonly side: number;
}): RevealArgs => ({
  strategy: input.strategyBytes,
  index: input.index,
  fixtureId: BigInt(input.fixtureId),
  market: MARKET_1X2,
  side: input.side,
  fairProbBps: Number.parseInt(process.env['E2E_FAIR_PROB_BPS'] ?? '5000', 10),
  entryOddsMilli: Number.parseInt(process.env['E2E_ENTRY_ODDS_MILLI'] ?? '2000', 10),
  stake: BigInt(process.env['E2E_STAKE'] ?? '25000000'),
  signalHash: sha256Bytes(`txline-e2e-signal:${input.fixtureId}`),
  nonce: new Uint8Array(randomBytes(32)),
});

// Commit a fresh decision at the current on-chain index, returning the index and reveal so
// the caller can build the matching settle args.
const commitDecision = async (
  port: SolanaOnChainPort,
  strategyBytes: Uint8Array,
  fixtureId: number,
  side: number,
): Promise<{ readonly index: bigint; readonly reveal: RevealArgs }> => {
  const strategyState = await port.readStrategy();
  if (!strategyState.ok) {
    return fail(`readStrategy failed: ${strategyState.error.kind} ${strategyState.error.detail}`);
  }
  if (strategyState.value === null) {
    return fail('strategy account missing at commit time');
  }
  const index = strategyState.value.decisionsCount;
  const reveal = buildReveal({ strategyBytes, index, fixtureId, side });
  const commitHash = computeCommitHash(reveal);
  if (!commitHash.ok) {
    return fail(`commit hash encode failed: ${commitHash.error.field} ${commitHash.error.detail}`);
  }
  const committed = await port.commit({
    commitHash: commitHash.value,
    fixtureId: BigInt(fixtureId),
    market: MARKET_1X2,
    reveal,
  });
  if (!committed.ok) {
    return fail(`commit failed: ${committed.error.kind} ${committed.error.detail}`);
  }
  console.log(`[settle-e2e] committed decision index ${committed.value.index}: ${explorerTx(committed.value.txSig)}`);
  return { index: committed.value.index, reveal };
};

const main = async (): Promise<void> => {
  const missing = REQUIRED_ENV.filter((key) => {
    const value = process.env[key];
    return value === undefined || value.length === 0;
  });
  if (missing.length > 0) {
    console.log(`[settle-e2e] skipped (devnet wallet and TxLINE token not configured). Missing: ${missing.join(', ')}`);
    console.log('[settle-e2e] see docs/runbooks/M4-devnet.md to provide these in .env, then re-run.');
    return;
  }

  const configResult = loadDevnetConfig(process.env);
  if (!configResult.ok) {
    return fail(`config error: ${configResult.error.field} ${configResult.error.detail}`);
  }
  const signerResult = await loadKeypairSigner(
    (path) => readFile(path, 'utf8'),
    configResult.value.keypairPath,
  );
  if (!signerResult.ok) {
    return fail(`keypair error: ${signerResult.error.field} ${signerResult.error.detail}`);
  }
  const port = createDevnetPort(configResult.value, signerResult.value);
  const strategyBytes = addressToBytes(await port.strategyAddress());

  // Ensure the strategy ledger exists, pinning the txoracle program as the CPI target.
  const existing = await port.readStrategy();
  if (!existing.ok) {
    return fail(`readStrategy failed: ${existing.error.kind} ${existing.error.detail}`);
  }
  if (existing.value === null) {
    const startingBankroll = BigInt(process.env['STARTING_BANKROLL'] ?? '1000000000');
    const initialized = await port.initializeStrategy(startingBankroll);
    if (!initialized.ok) {
      return fail(`initializeStrategy failed: ${initialized.error.kind} ${initialized.error.detail}`);
    }
    console.log(`[settle-e2e] initialized strategy: ${explorerTx(initialized.value.txSig)}`);
  } else {
    console.log(`[settle-e2e] strategy already initialized (decisions so far: ${existing.value.decisionsCount})`);
  }

  // Fetch the two-stat (home goals statKey 1, away goals statKey 2) three-stage proof.
  const fixtureId = Number.parseInt(requireEnvValue('E2E_FIXTURE_ID'), 10);
  const seq = Number.parseInt(requireEnvValue('E2E_SEQ'), 10);
  const txline = new TxlineClient(
    {
      http: new FetchHttpClient(),
      sleep: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
      prng: new SeededPrng(1),
      dataBaseUrl: requireEnvValue('TXLINE_DATA_BASE_URL'),
      authBaseUrl: requireEnvValue('TXLINE_AUTH_BASE_URL'),
    },
    { jwt: requireEnvValue('TXLINE_JWT'), apiToken: requireEnvValue('TXLINE_API_TOKEN') },
  );
  const proof = await txline.getScoresStatValidation({ fixtureId, seq, statKey: 1, statKey2: 2 });
  if (!proof.ok) {
    return fail(`stat-validation fetch failed: ${proof.error.kind} (${proof.error.detail})`);
  }
  const validation = proof.value;
  if (validation.statToProve2 === undefined) {
    return fail('API returned no second stat; a 1X2 settle needs statKey2 (away goals)');
  }

  // The honest claim: derive the result from the proven home and away goals.
  const homeGoals = validation.statToProve.value;
  const awayGoals = validation.statToProve2.value;
  const claimedResult =
    homeGoals > awayGoals ? SIDE_HOME : homeGoals === awayGoals ? SIDE_DRAW : SIDE_AWAY;
  console.log(`[settle-e2e] proven score home ${homeGoals} away ${awayGoals}; claimed result ${claimedResult}`);

  // Decision A: a winning bet on the actual result, settled by CPI into validate_stat.
  const decisionA = await commitDecision(port, strategyBytes, fixtureId, claimedResult);
  const settleArgsA = buildSettleArgs({ validation, reveal: decisionA.reveal, claimedResult });
  if (!settleArgsA.ok) {
    return fail(
      `buildSettleArgs failed: ${settleArgsA.error.field} ${settleArgsA.error.detail} (a hash-format error here means the wire encoding is not hex; see the runbook O4 note)`,
    );
  }
  const settledA = await port.settle({ index: decisionA.index, settleArgs: settleArgsA.value });
  if (!settledA.ok) {
    return fail(`settle reverted unexpectedly on a valid proof: ${settledA.error.detail}`);
  }
  console.log(`[settle-e2e] settled decision A won=${settledA.value.won} pnl=${settledA.value.pnl}: ${explorerTx(settledA.value.txSig)}`);

  // Decision B: prove a tampered proof is rejected, then a valid one settles.
  const decisionB = await commitDecision(port, strategyBytes, fixtureId, claimedResult);
  const settleArgsB = buildSettleArgs({ validation, reveal: decisionB.reveal, claimedResult });
  if (!settleArgsB.ok) {
    return fail(`buildSettleArgs (B) failed: ${settleArgsB.error.field} ${settleArgsB.error.detail}`);
  }
  const tamperedAttempt = await port.settle({
    index: decisionB.index,
    settleArgs: tamperSettleArgs(settleArgsB.value),
  });
  if (tamperedAttempt.ok) {
    return fail('SECURITY FAILURE: a tampered proof settled; the CPI did not reject it');
  }
  console.log(`[settle-e2e] tampered proof correctly rejected (settle reverted): ${tamperedAttempt.error.detail}`);

  const settledB = await port.settle({ index: decisionB.index, settleArgs: settleArgsB.value });
  if (!settledB.ok) {
    return fail(`valid settle after tamper failed: ${settledB.error.detail}`);
  }
  console.log(`[settle-e2e] settled decision B won=${settledB.value.won} pnl=${settledB.value.pnl}: ${explorerTx(settledB.value.txSig)}`);

  // Decision C: prove the fixture binding (M8 audit V1). A proof for a different fixture must
  // be rejected, so a winning proof from another match cannot be substituted.
  const decisionC = await commitDecision(port, strategyBytes, fixtureId, claimedResult);
  const settleArgsC = buildSettleArgs({ validation, reveal: decisionC.reveal, claimedResult });
  if (!settleArgsC.ok) {
    return fail(`buildSettleArgs (C) failed: ${settleArgsC.error.field} ${settleArgsC.error.detail}`);
  }
  const wrongFixtureArgs: SettleArgsInput = {
    ...settleArgsC.value,
    fixtureSummary: {
      ...settleArgsC.value.fixtureSummary,
      fixtureId: settleArgsC.value.fixtureSummary.fixtureId + 1n,
    },
  };
  const fixtureAttempt = await port.settle({ index: decisionC.index, settleArgs: wrongFixtureArgs });
  if (fixtureAttempt.ok) {
    return fail('SECURITY FAILURE: a settle with a mismatched fixture summary succeeded (V1)');
  }
  console.log(`[settle-e2e] mismatched-fixture settle correctly rejected (V1): ${fixtureAttempt.error.detail}`);

  // Decision D: prove the stat-key pin (M8 audit V2). Swapping the home and away stats must be
  // rejected, so the (home - away) predicate cannot be made to test the winning participant.
  const decisionD = await commitDecision(port, strategyBytes, fixtureId, claimedResult);
  const settleArgsD = buildSettleArgs({ validation, reveal: decisionD.reveal, claimedResult });
  if (!settleArgsD.ok) {
    return fail(`buildSettleArgs (D) failed: ${settleArgsD.error.field} ${settleArgsD.error.detail}`);
  }
  const swappedStatArgs: SettleArgsInput = {
    ...settleArgsD.value,
    statHome: settleArgsD.value.statAway,
    statAway: settleArgsD.value.statHome,
  };
  const statAttempt = await port.settle({ index: decisionD.index, settleArgs: swappedStatArgs });
  if (statAttempt.ok) {
    return fail('SECURITY FAILURE: a settle with swapped stat keys succeeded (V2)');
  }
  console.log(`[settle-e2e] swapped-stat settle correctly rejected (V2): ${statAttempt.error.detail}`);

  const finalState = await port.readStrategy();
  if (finalState.ok && finalState.value !== null) {
    console.log(`[settle-e2e] strategy bankroll ${finalState.value.bankroll} realizedPnl ${finalState.value.realizedPnl} wins ${finalState.value.wins} losses ${finalState.value.losses}`);
  }
  console.log('[settle-e2e] M4 devnet proof complete: committed before reveal, settled by CPI into validate_stat, tamper rejected.');
};

main().catch((error: unknown) => {
  console.error(`[settle-e2e] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
