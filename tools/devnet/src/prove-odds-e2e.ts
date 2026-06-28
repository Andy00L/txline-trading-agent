import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SeededPrng } from '@txline-agent/core';
import {
  FetchHttpClient,
  TxlineClient,
  type OddsPayload,
  type OddsValidation,
  type ScoresStatValidation,
} from '@txline-agent/txline';
import {
  addressToBytes,
  buildProveOddsArgs,
  buildSettleArgs,
  computeCommitHash,
  createDevnetPort,
  loadDevnetConfig,
  loadKeypairSigner,
  type OddsValidationInput,
  type ProveOddsArgsInput,
  type RevealArgs,
  type SolanaOnChainPort,
} from '@txline-agent/onchain-client';

// 1X2 sides in participant space, mirroring programs/agent_ledger/src/state.rs SIDE_* and the
// off-chain Outcome: side 0 = participant 1 (home) wins, 1 = draw, 2 = participant 2 (away) wins.
const SIDE_HOME = 0;
const SIDE_DRAW = 1;
const SIDE_AWAY = 2;
const MARKET_1X2 = 0;

// The 1X2 result market's SuperOddsType in the odds feed; the entry-odds proof must be for this
// market. sourceRef: programs/agent_ledger/src/state.rs SUPER_ODDS_TYPE_1X2, packages/core market.ts.
const SUPER_ODDS_TYPE_1X2 = '1X2_PARTICIPANT_RESULT';

// The numeric soccer phases that mean the final whistle has blown, so a settled score exists.
// sourceRef: packages/txline/src/schemas/scores.ts (StatusId 5 F, 10 FET, 13 FPE).
const FINAL_STATUS_IDS = new Set<number>([5, 10, 13]);

// Score stat keys for the two-stat 1X2 predicate. sourceRef: state.rs STAT_KEY_PARTICIPANT{1,2}.
const STAT_KEY_PARTICIPANT1 = 1;
const STAT_KEY_PARTICIPANT2 = 2;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const INTERVALS_PER_HOUR = 12; // the /updates feed buckets each hour into 12 five-minute intervals.

// How far back to scan the scores-updates feed for a freshly finished fixture, and how far back from
// a fixture's final-whistle ts to scan the odds-updates feed for a 1X2 message still inside the
// odds-validation window. Bounded so discovery makes a predictable number of requests.
const SCORES_LOOKBACK_HOURS = 14;
const ODDS_LOOKBACK_HOURS = 6;

// The env keys the live run needs. Without all of them the script skips cleanly, so it is safe to
// invoke before the wallet and token exist. Mirrors settle-e2e.ts REQUIRED_ENV.
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
    console.error(`[prove-odds-e2e] missing required env ${key}`);
    process.exit(1);
  }
  return value;
};

const fail = (message: string): never => {
  console.error(`[prove-odds-e2e] ${message}`);
  process.exit(1);
};

// The 1X2 result side a price label denotes, matching the on-chain side_matches_label: home is
// "1"/"part1", draw is "X"/"draw", away is "2"/"part2" (trimmed, case-insensitive). Returns null for
// any other label so a non-1X2 column is never mistaken for a side. sourceRef: logic.rs side_matches_label.
const sideForLabel = (label: string): number | null => {
  const lowered = label.trim().toLowerCase();
  if (lowered === '1' || lowered === 'part1') {
    return SIDE_HOME;
  }
  if (lowered === 'x' || lowered === 'draw') {
    return SIDE_DRAW;
  }
  if (lowered === '2' || lowered === 'part2') {
    return SIDE_AWAY;
  }
  return null;
};

// The result side implied by the final goals, in the same participant space as reveal.side.
const resultSideFromGoals = (homeGoals: number, awayGoals: number): number =>
  homeGoals > awayGoals ? SIDE_HOME : homeGoals === awayGoals ? SIDE_DRAW : SIDE_AWAY;

type WindowCoord = { readonly epochDay: number; readonly hourOfDay: number };

// The (epochDay, hourOfDay) buckets covering the lookbackHours up to and including the bucket of
// anchorTs, newest first. Used to walk the /updates feed backwards from a reference time.
const lookbackWindows = (anchorTs: number, lookbackHours: number): WindowCoord[] => {
  const windows: WindowCoord[] = [];
  for (let hoursBack = 0; hoursBack < lookbackHours; hoursBack += 1) {
    const bucketTs = anchorTs - hoursBack * HOUR_MS;
    windows.push({
      epochDay: Math.floor(bucketTs / DAY_MS),
      hourOfDay: Math.floor((bucketTs % DAY_MS) / HOUR_MS),
    });
  }
  return windows;
};

// A finished fixture the score feed can prove: its id, the seq that carries the final whistle, and
// the timestamp of that final record (the anchor for the odds-window scan).
type FinishedFixture = {
  readonly fixtureId: number;
  readonly seq: number;
  readonly statusId: number;
  readonly finalTs: number;
};

// Scan the scores-updates feed back over SCORES_LOOKBACK_HOURS from anchorTs and collect every
// fixture that reached a final StatusId, keyed by fixture with the highest seq (the latest record).
const discoverFinishedFixtures = async (
  txline: TxlineClient,
  anchorTs: number,
): Promise<Map<number, FinishedFixture>> => {
  const finished = new Map<number, FinishedFixture>();
  for (const { epochDay, hourOfDay } of lookbackWindows(anchorTs, SCORES_LOOKBACK_HOURS)) {
    for (let interval = 0; interval < INTERVALS_PER_HOUR; interval += 1) {
      const updates = await txline.getScoresUpdates(epochDay, hourOfDay, interval);
      if (!updates.ok) {
        continue;
      }
      for (const record of updates.value) {
        const statusId = record.StatusId;
        if (statusId === null || statusId === undefined || !FINAL_STATUS_IDS.has(statusId)) {
          continue;
        }
        const previous = finished.get(record.FixtureId);
        if (previous === undefined || record.Seq > previous.seq) {
          finished.set(record.FixtureId, {
            fixtureId: record.FixtureId,
            seq: record.Seq,
            statusId,
            finalTs: record.Ts,
          });
        }
      }
    }
  }
  return finished;
};

// Find the latest 1X2 odds update for a fixture in the ODDS_LOOKBACK_HOURS up to anchorTs. The
// snapshot endpoint is empty once a match ends, but the historical /updates records persist and stay
// inside the odds-validation window for a couple of days, so the proof can still be fetched.
const findOneX2OddsUpdate = async (
  txline: TxlineClient,
  fixtureId: number,
  anchorTs: number,
): Promise<OddsPayload | null> => {
  for (const { epochDay, hourOfDay } of lookbackWindows(anchorTs, ODDS_LOOKBACK_HOURS)) {
    for (let interval = INTERVALS_PER_HOUR - 1; interval >= 0; interval -= 1) {
      const updates = await txline.getOddsUpdates(epochDay, hourOfDay, interval);
      if (!updates.ok) {
        continue;
      }
      let latest: OddsPayload | null = null;
      for (const odds of updates.value) {
        if (odds.FixtureId !== fixtureId || odds.SuperOddsType !== SUPER_ODDS_TYPE_1X2) {
          continue;
        }
        const priceNames = odds.PriceNames ?? [];
        const prices = odds.Prices ?? [];
        if (priceNames.length === 0 || priceNames.length !== prices.length) {
          continue;
        }
        latest = odds;
      }
      if (latest !== null) {
        return latest;
      }
    }
  }
  return null;
};

// A fully resolved proof target: a fixture with a final score AND a fetched, validating 1X2 odds
// snapshot, plus the backed side and its sealed entry price (the published price for that side).
export type ProofTarget = {
  readonly fixtureId: number;
  readonly seq: number;
  readonly scoreValidation: ScoresStatValidation;
  readonly oddsValidation: OddsValidation;
  readonly homeGoals: number;
  readonly awayGoals: number;
  readonly resultSide: number;
  readonly sideIndex: number;
  readonly entryOddsMilli: number;
};

// Given a fixture and the seq of its final-whistle score, fetch the two-stat score proof and the
// matching 1X2 odds validation, then locate the backed side's column (sideIndex) and its price.
// Returns null (with a logged reason) when any piece is missing, so the caller can try the next
// fixture. The odds-window scan is anchored at the score ts.
const resolveProofTarget = async (
  txline: TxlineClient,
  fixtureId: number,
  seq: number,
): Promise<ProofTarget | null> => {
  const scoreResult = await txline.getScoresStatValidation({
    fixtureId,
    seq,
    statKey: STAT_KEY_PARTICIPANT1,
    statKey2: STAT_KEY_PARTICIPANT2,
  });
  if (!scoreResult.ok) {
    console.log(`[prove-odds-e2e]   fixture ${fixtureId}: score proof unavailable (${scoreResult.error.kind})`);
    return null;
  }
  const scoreValidation = scoreResult.value;
  if (scoreValidation.statToProve2 === undefined) {
    console.log(`[prove-odds-e2e]   fixture ${fixtureId}: score proof has no second stat (away goals)`);
    return null;
  }
  const homeGoals = scoreValidation.statToProve.value;
  const awayGoals = scoreValidation.statToProve2.value;
  const resultSide = resultSideFromGoals(homeGoals, awayGoals);

  const oddsUpdate = await findOneX2OddsUpdate(txline, fixtureId, scoreValidation.ts);
  if (oddsUpdate === null) {
    console.log(`[prove-odds-e2e]   fixture ${fixtureId}: no 1X2 odds update in the ${ODDS_LOOKBACK_HOURS}h pre-score window`);
    return null;
  }
  const priceNames = oddsUpdate.PriceNames ?? [];
  const prices = oddsUpdate.Prices ?? [];
  const sideIndex = priceNames.findIndex((label) => sideForLabel(label) === resultSide);
  if (sideIndex < 0) {
    console.log(`[prove-odds-e2e]   fixture ${fixtureId}: no price column matches result side ${resultSide} in ${JSON.stringify(priceNames)}`);
    return null;
  }
  const entryOddsMilli = prices[sideIndex];
  if (entryOddsMilli === undefined) {
    console.log(`[prove-odds-e2e]   fixture ${fixtureId}: price missing at side index ${sideIndex}`);
    return null;
  }

  const oddsValidationResult = await txline.getOddsValidation({
    messageId: oddsUpdate.MessageId,
    ts: oddsUpdate.Ts,
  });
  if (!oddsValidationResult.ok) {
    console.log(`[prove-odds-e2e]   fixture ${fixtureId}: odds validation fetch failed (${oddsValidationResult.error.kind})`);
    return null;
  }

  return {
    fixtureId,
    seq,
    scoreValidation,
    oddsValidation: oddsValidationResult.value,
    homeGoals,
    awayGoals,
    resultSide,
    sideIndex,
    entryOddsMilli,
  };
};

// Pick a proof target. First try the .env fixture (a known finished fixture) for both halves; if its
// odds have aged out of the validation window (the common case for an older fixture), discover a
// recently finished World Cup fixture that still has a fresh 1X2 odds proof. A decisive (non-draw)
// result is preferred so the demo backs a clear winner, but a draw is accepted if that is all there is.
export const selectProofTarget = async (
  txline: TxlineClient,
  envFixtureId: number,
  envSeq: number,
): Promise<ProofTarget> => {
  console.log(`[prove-odds-e2e] trying the .env fixture ${envFixtureId} (seq ${envSeq}) for a score + fresh odds`);
  const envTarget = await resolveProofTarget(txline, envFixtureId, envSeq);
  if (envTarget !== null) {
    console.log(`[prove-odds-e2e] .env fixture ${envFixtureId} has both; using it`);
    return envTarget;
  }

  console.log('[prove-odds-e2e] .env fixture lacks a fresh 1X2 odds proof; discovering a recently finished fixture');
  // Anchor discovery at the larger of wall-clock now and the .env fixture's score ts, so the scan
  // lands on days the replay feed actually carries (the feed clock can run ahead of wall time).
  let anchorTs = Date.now();
  const envScore = await txline.getScoresStatValidation({
    fixtureId: envFixtureId,
    seq: envSeq,
    statKey: STAT_KEY_PARTICIPANT1,
    statKey2: STAT_KEY_PARTICIPANT2,
  });
  if (envScore.ok && envScore.value.ts > anchorTs) {
    anchorTs = envScore.value.ts;
  }
  console.log(`[prove-odds-e2e] discovery anchor ts ${anchorTs} (epoch day ${Math.floor(anchorTs / DAY_MS)})`);

  const finished = await discoverFinishedFixtures(txline, anchorTs);
  console.log(`[prove-odds-e2e] finished fixtures in the last ${SCORES_LOOKBACK_HOURS}h: ${finished.size}`);
  if (finished.size === 0) {
    return fail('no finished fixture found on the scores-updates feed; cannot prove an entry price without a settled result');
  }

  // Two passes over the same candidates: prefer a decisive result, then accept a draw. A bounded
  // attempt count keeps the request volume predictable even when many candidates lack fresh odds.
  const candidates = [...finished.values()];
  const maxAttempts = Math.min(candidates.length, 12);
  let drawFallback: ProofTarget | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = candidates[attempt];
    if (candidate === undefined) {
      break;
    }
    const target = await resolveProofTarget(txline, candidate.fixtureId, candidate.seq);
    if (target === null) {
      continue;
    }
    if (target.resultSide !== SIDE_DRAW) {
      console.log(`[prove-odds-e2e] selected fixture ${target.fixtureId}: decisive result side ${target.resultSide}`);
      return target;
    }
    if (drawFallback === null) {
      drawFallback = target;
    }
  }
  if (drawFallback !== null) {
    console.log(`[prove-odds-e2e] selected fixture ${drawFallback.fixtureId}: draw result (no decisive candidate had fresh odds)`);
    return drawFallback;
  }
  return fail(`none of the ${finished.size} finished fixtures had a fresh validating 1X2 odds proof; the odds aged out of the validation window`);
};

// Build the sealed reveal for a decision. side, entryOddsMilli, and stake are the sealed economics;
// the rest mirror settle-e2e.ts so the cross-language commit-hash golden stays the reference.
const buildReveal = (input: {
  readonly strategyBytes: Uint8Array;
  readonly index: bigint;
  readonly fixtureId: number;
  readonly side: number;
  readonly entryOddsMilli: number;
}): RevealArgs => ({
  strategy: input.strategyBytes,
  index: input.index,
  fixtureId: BigInt(input.fixtureId),
  market: MARKET_1X2,
  side: input.side,
  fairProbBps: Number.parseInt(process.env['E2E_FAIR_PROB_BPS'] ?? '5000', 10),
  entryOddsMilli: input.entryOddsMilli,
  stake: BigInt(process.env['E2E_STAKE'] ?? '25000000'),
  signalHash: sha256Bytes(`txline-prove-odds-signal:${input.fixtureId}`),
  nonce: new Uint8Array(randomBytes(32)),
});

// Commit a fresh decision at the current on-chain index, returning the index and reveal so the
// caller can build the matching settle and prove args. Mirrors settle-e2e.ts commitDecision.
const commitDecision = async (
  port: SolanaOnChainPort,
  strategyBytes: Uint8Array,
  fixtureId: number,
  side: number,
  entryOddsMilli: number,
): Promise<{ readonly index: bigint; readonly reveal: RevealArgs }> => {
  const strategyState = await port.readStrategy();
  if (!strategyState.ok) {
    return fail(`readStrategy failed: ${strategyState.error.kind} ${strategyState.error.detail}`);
  }
  if (strategyState.value === null) {
    return fail('strategy account missing at commit time');
  }
  const index = strategyState.value.decisionsCount;
  const reveal = buildReveal({ strategyBytes, index, fixtureId, side, entryOddsMilli });
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
  console.log(`[prove-odds-e2e] committed decision index ${committed.value.index}: ${explorerTx(committed.value.txSig)}`);
  return { index: committed.value.index, reveal };
};

// Settle a committed decision against the winning side, so its status becomes SETTLED and
// prove_entry_odds (which requires SETTLED) can run. Reverts the run on an unexpected settle failure.
const settleWinning = async (
  port: SolanaOnChainPort,
  index: bigint,
  scoreValidation: ScoresStatValidation,
  reveal: RevealArgs,
  resultSide: number,
  label: string,
): Promise<void> => {
  const settleArgs = buildSettleArgs({ validation: scoreValidation, reveal, claimedResult: resultSide });
  if (!settleArgs.ok) {
    return fail(`buildSettleArgs (${label}) failed: ${settleArgs.error.field} ${settleArgs.error.detail}`);
  }
  const settled = await port.settle({ index, settleArgs: settleArgs.value });
  if (!settled.ok) {
    return fail(`settle (${label}) reverted unexpectedly on a valid proof: ${settled.error.detail}`);
  }
  console.log(`[prove-odds-e2e] settled decision ${label} won=${settled.value.won} pnl=${settled.value.pnl}: ${explorerTx(settled.value.txSig)}`);
};

// Flip the proven price for the backed side to a different value, so the on-chain
// prices[side_index] == entry_odds_milli check must fail (AgentError::OddsPriceMismatch) before the
// CPI even runs. Adds 1 (or subtracts 1 at the i32 ceiling) so the tampered price stays a valid i32.
const tamperOddsPrice = (
  args: ProveOddsArgsInput,
  sideIndex: number,
): ProveOddsArgsInput => {
  const tamperedPrices = [...args.oddsSnapshot.prices];
  const original = tamperedPrices[sideIndex] ?? 0;
  tamperedPrices[sideIndex] = original === 2_147_483_647 ? original - 1 : original + 1;
  return {
    ...args,
    oddsSnapshot: { ...args.oddsSnapshot, prices: tamperedPrices },
  };
};

const main = async (): Promise<void> => {
  const missing = REQUIRED_ENV.filter((key) => {
    const value = process.env[key];
    return value === undefined || value.length === 0;
  });
  if (missing.length > 0) {
    console.log(`[prove-odds-e2e] skipped (devnet wallet and TxLINE token not configured). Missing: ${missing.join(', ')}`);
    console.log('[prove-odds-e2e] see docs/runbooks/M4-devnet.md to provide these in .env, then re-run.');
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

  // Reuse the existing strategy; initialize it only if it does not exist yet (new commits create
  // new-layout DecisionCommit accounts, so only old decisions are unreadable, and this run touches
  // only the ones it creates). Mirrors settle-e2e.ts.
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
    console.log(`[prove-odds-e2e] initialized strategy: ${explorerTx(initialized.value.txSig)}`);
  } else {
    console.log(`[prove-odds-e2e] strategy already initialized (decisions so far: ${existing.value.decisionsCount})`);
  }

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

  const envFixtureId = Number.parseInt(requireEnvValue('E2E_FIXTURE_ID'), 10);
  const envSeq = Number.parseInt(requireEnvValue('E2E_SEQ'), 10);
  const target = await selectProofTarget(txline, envFixtureId, envSeq);
  const oddsValidationInput: OddsValidationInput = target.oddsValidation;
  const backedLabel = (target.oddsValidation.odds.PriceNames ?? [])[target.sideIndex] ?? '';
  console.log(
    `[prove-odds-e2e] fixture ${target.fixtureId}: score home ${target.homeGoals} away ${target.awayGoals}; backing side ${target.resultSide} (label "${backedLabel}") at sealed entry odds ${target.entryOddsMilli} (price index ${target.sideIndex})`,
  );
  console.log(`[prove-odds-e2e] odds message ...${target.oddsValidation.odds.MessageId.slice(-4)} ts ${target.oddsValidation.odds.Ts}`);

  // Decision A: a winning bet on the actual result, settled by CPI into validate_stat, then its
  // sealed entry price proven a real published quote by CPI into validate_odds.
  const decisionA = await commitDecision(
    port,
    strategyBytes,
    target.fixtureId,
    target.resultSide,
    target.entryOddsMilli,
  );
  await settleWinning(port, decisionA.index, target.scoreValidation, decisionA.reveal, target.resultSide, 'A');
  const proveArgsA = buildProveOddsArgs({
    validation: oddsValidationInput,
    reveal: decisionA.reveal,
    sideIndex: target.sideIndex,
  });
  if (!proveArgsA.ok) {
    return fail(`buildProveOddsArgs (A) failed: ${proveArgsA.error.field} ${proveArgsA.error.detail}`);
  }
  const provenA = await port.proveEntryOdds({ index: decisionA.index, proveOddsArgs: proveArgsA.value });
  if (!provenA.ok) {
    return fail(`prove_entry_odds (A) reverted unexpectedly on a valid odds proof: ${provenA.error.detail}`);
  }
  if (!provenA.value.proven) {
    return fail('prove_entry_odds (A) returned but the decision is not marked entry_odds_proven');
  }
  console.log(`[prove-odds-e2e] PROVEN entry odds for decision A (DecisionOddsProven): ${explorerTx(provenA.value.txSig)}`);

  // Decision B: prove a tampered odds snapshot is rejected, then prove it honestly so it lands
  // proven too. The tamper changes the backed side's price, so prices[side_index] != entry_odds_milli
  // and the program reverts with OddsPriceMismatch before the validate_odds CPI runs.
  const decisionB = await commitDecision(
    port,
    strategyBytes,
    target.fixtureId,
    target.resultSide,
    target.entryOddsMilli,
  );
  await settleWinning(port, decisionB.index, target.scoreValidation, decisionB.reveal, target.resultSide, 'B');
  const proveArgsB = buildProveOddsArgs({
    validation: oddsValidationInput,
    reveal: decisionB.reveal,
    sideIndex: target.sideIndex,
  });
  if (!proveArgsB.ok) {
    return fail(`buildProveOddsArgs (B) failed: ${proveArgsB.error.field} ${proveArgsB.error.detail}`);
  }
  const tamperedAttempt = await port.proveEntryOdds({
    index: decisionB.index,
    proveOddsArgs: tamperOddsPrice(proveArgsB.value, target.sideIndex),
  });
  if (tamperedAttempt.ok) {
    return fail('SECURITY FAILURE: a tampered entry-odds price proved; the program did not reject the price mismatch');
  }
  console.log(`[prove-odds-e2e] tampered entry-odds price correctly rejected (prove reverted): ${tamperedAttempt.error.detail}`);

  const provenB = await port.proveEntryOdds({ index: decisionB.index, proveOddsArgs: proveArgsB.value });
  if (!provenB.ok) {
    return fail(`prove_entry_odds (B) reverted unexpectedly on the honest retry: ${provenB.error.detail}`);
  }
  if (!provenB.value.proven) {
    return fail('prove_entry_odds (B) honest retry returned but the decision is not marked entry_odds_proven');
  }
  console.log(`[prove-odds-e2e] PROVEN entry odds for decision B after rejecting the tamper: ${explorerTx(provenB.value.txSig)}`);

  const finalState = await port.readStrategy();
  if (finalState.ok && finalState.value !== null) {
    console.log(
      `[prove-odds-e2e] strategy bankroll ${finalState.value.bankroll} realizedPnl ${finalState.value.realizedPnl} wins ${finalState.value.wins} losses ${finalState.value.losses} decisions ${finalState.value.decisionsCount}`,
    );
  }
  console.log(
    `[prove-odds-e2e] entry-odds proof complete on fixture ${target.fixtureId}: committed before reveal, settled by CPI into validate_stat, entry price proven a real published quote by CPI into validate_odds, tampered price rejected.`,
  );
};

// Auto-run only when executed directly (node dist/prove-odds-e2e.js), not when imported by another
// devnet script. prove-odds-live.ts reuses selectProofTarget to drive the live OnChainSink.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[prove-odds-e2e] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
