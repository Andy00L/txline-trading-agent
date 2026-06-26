import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  addressToBytes,
  computeCommitHash,
  createDevnetPort,
  loadDevnetConfig,
  loadKeypairSigner,
  type RevealArgs,
} from '@txline-agent/onchain-client';

// A minimal on-chain smoke test of the production OnChainPort write path: initialize the
// strategy, commit one sealed decision, and read the committed account back. It needs no
// TxLINE token and no txoracle, so it runs against any cluster (a local validator with the
// program preloaded, or devnet once the wallet is funded). The settle half lives in
// settle-e2e.ts. sourceRef: docs/runbooks/M4-devnet.md.

const SIDE_HOME = 0;
const MARKET_1X2 = 0;
const DEMO_FIXTURE_ID = 999_001;

const sha256Bytes = (text: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(text).digest());

const fail = (message: string): never => {
  console.error(`[commit-demo] ${message}`);
  process.exit(1);
};

const main = async (): Promise<void> => {
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
  const strategyAddress = await port.strategyAddress();
  console.log(`[commit-demo] strategy PDA ${strategyAddress}`);

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
    console.log(`[commit-demo] initialized strategy, tx ${initialized.value.txSig}`);
  } else {
    console.log(`[commit-demo] strategy already exists (decisions so far: ${existing.value.decisionsCount})`);
  }

  const current = await port.readStrategy();
  if (!current.ok || current.value === null) {
    return fail('strategy missing after initialize');
  }
  const index = current.value.decisionsCount;
  const reveal: RevealArgs = {
    strategy: addressToBytes(strategyAddress),
    index,
    fixtureId: BigInt(DEMO_FIXTURE_ID),
    market: MARKET_1X2,
    side: SIDE_HOME,
    fairProbBps: 5000,
    entryOddsMilli: 2000,
    stake: 25_000_000n,
    signalHash: sha256Bytes(`commit-demo-signal:${DEMO_FIXTURE_ID}`),
    nonce: sha256Bytes(`commit-demo-nonce:${index}`),
  };
  const commitHash = computeCommitHash(reveal);
  if (!commitHash.ok) {
    return fail(`commit hash encode failed: ${commitHash.error.field} ${commitHash.error.detail}`);
  }
  const committed = await port.commit({
    commitHash: commitHash.value,
    fixtureId: BigInt(DEMO_FIXTURE_ID),
    market: MARKET_1X2,
    reveal,
  });
  if (!committed.ok) {
    return fail(`commit failed: ${committed.error.kind} ${committed.error.detail}`);
  }
  console.log(`[commit-demo] committed decision index ${committed.value.index}, tx ${committed.value.txSig}`);
  console.log(`[commit-demo] decision PDA ${committed.value.positionId}`);

  const decision = await port.readDecision(committed.value.index);
  if (!decision.ok || decision.value === null) {
    return fail('could not read the committed decision account back');
  }
  console.log(`[commit-demo] read back decision: fixtureId ${decision.value.fixtureId} market ${decision.value.market} status ${decision.value.status} (0=open)`);
  console.log('[commit-demo] on-chain write path verified: initialize_strategy + commit_decision executed and the sealed decision is on the ledger.');
};

main().catch((error: unknown) => {
  console.error(`[commit-demo] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
