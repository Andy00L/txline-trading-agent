import { err, ok, type Result } from '@txline-agent/core';
import { encodeRevealArgs, type EncodeError, type RevealArgs } from './borsh.js';
import { BorshWriter } from './borsh-writer.js';
import { badLength, checkI32, checkI64, checkU32, checkU8 } from './int-range.js';
import type { ProofNodeInput } from './settle-encode.js';

/** Mirror of the on-chain Odds snapshot (programs/agent_ledger/src/txline_cpi.rs). */
export type OddsSnapshotInput = {
  readonly fixtureId: bigint;
  readonly messageId: string;
  readonly ts: bigint;
  readonly bookmaker: string;
  readonly bookmakerId: number;
  readonly superOddsType: string;
  readonly gameState: string | null;
  readonly inRunning: boolean;
  readonly marketParameters: string | null;
  readonly marketPeriod: string | null;
  readonly priceNames: readonly string[];
  readonly prices: readonly number[];
};

export type OddsUpdateStatsInput = {
  readonly updateCount: number;
  readonly minTimestamp: bigint;
  readonly maxTimestamp: bigint;
};

export type OddsBatchSummaryInput = {
  readonly fixtureId: bigint;
  readonly updateStats: OddsUpdateStatsInput;
  readonly oddsSubTreeRoot: Uint8Array;
};

/** Mirror of the on-chain ProveOddsArgs (programs/agent_ledger/src/state.rs). */
export type ProveOddsArgsInput = {
  readonly reveal: RevealArgs;
  readonly ts: bigint;
  readonly oddsSnapshot: OddsSnapshotInput;
  readonly summary: OddsBatchSummaryInput;
  readonly subTreeProof: readonly ProofNodeInput[];
  readonly mainTreeProof: readonly ProofNodeInput[];
  readonly sideIndex: number;
};

const checkProof = (proof: readonly ProofNodeInput[], label: string): EncodeError | null => {
  for (let index = 0; index < proof.length; index += 1) {
    const node = proof[index];
    if (node && node.hash.length !== 32) {
      return badLength(`${label}[${index}].hash`, node.hash.length);
    }
  }
  return null;
};

const checkPrices = (prices: readonly number[]): EncodeError | null => {
  for (let index = 0; index < prices.length; index += 1) {
    const price = prices[index];
    if (price === undefined) {
      continue;
    }
    const failure = checkI32(price, `oddsSnapshot.prices[${index}]`);
    if (failure) {
      return failure;
    }
  }
  return null;
};

const writeProofVec = (writer: BorshWriter, proof: readonly ProofNodeInput[]): void => {
  writer.vecLen(proof.length);
  for (const node of proof) {
    writer.bytes(node.hash);
    writer.bool(node.isRightSibling);
  }
};

const writeOddsSnapshot = (writer: BorshWriter, odds: OddsSnapshotInput): void => {
  writer.i64(odds.fixtureId);
  writer.str(odds.messageId);
  writer.i64(odds.ts);
  writer.str(odds.bookmaker);
  writer.i32(odds.bookmakerId);
  writer.str(odds.superOddsType);
  writer.optionStr(odds.gameState);
  writer.bool(odds.inRunning);
  writer.optionStr(odds.marketParameters);
  writer.optionStr(odds.marketPeriod);
  writer.vecLen(odds.priceNames.length);
  for (const name of odds.priceNames) {
    writer.str(name);
  }
  writer.vecLen(odds.prices.length);
  for (const price of odds.prices) {
    writer.i32(price);
  }
};

/**
 * Borsh-encode ProveOddsArgs for the prove_entry_odds instruction data (after the discriminator).
 * Byte-identical to the Rust struct, field by field; pinned by a cross-language golden
 * (prove-odds-encode.test.ts against state.rs canonical_prove_odds_args_borsh_is_stable). Every
 * integer is range-checked against its on-chain width first, because the DataView writers wrap a
 * too-wide value silently and would prove a different price than intended.
 */
export const encodeProveOddsArgs = (args: ProveOddsArgsInput): Result<Uint8Array, EncodeError> => {
  const reveal = encodeRevealArgs(args.reveal);
  if (!reveal.ok) {
    return reveal;
  }
  const failure =
    checkI64(args.ts, 'ts') ??
    checkI64(args.oddsSnapshot.fixtureId, 'oddsSnapshot.fixtureId') ??
    checkI64(args.oddsSnapshot.ts, 'oddsSnapshot.ts') ??
    checkI32(args.oddsSnapshot.bookmakerId, 'oddsSnapshot.bookmakerId') ??
    checkPrices(args.oddsSnapshot.prices) ??
    checkI64(args.summary.fixtureId, 'summary.fixtureId') ??
    checkU32(args.summary.updateStats.updateCount, 'summary.updateStats.updateCount') ??
    checkI64(args.summary.updateStats.minTimestamp, 'summary.updateStats.minTimestamp') ??
    checkI64(args.summary.updateStats.maxTimestamp, 'summary.updateStats.maxTimestamp') ??
    (args.summary.oddsSubTreeRoot.length === 32
      ? null
      : badLength('summary.oddsSubTreeRoot', args.summary.oddsSubTreeRoot.length)) ??
    checkProof(args.subTreeProof, 'subTreeProof') ??
    checkProof(args.mainTreeProof, 'mainTreeProof') ??
    checkU8(args.sideIndex, 'sideIndex');
  if (failure) {
    return err(failure);
  }

  const writer = new BorshWriter();
  writer.bytes(reveal.value);
  writer.i64(args.ts);
  writeOddsSnapshot(writer, args.oddsSnapshot);
  writer.i64(args.summary.fixtureId);
  writer.u32(args.summary.updateStats.updateCount);
  writer.i64(args.summary.updateStats.minTimestamp);
  writer.i64(args.summary.updateStats.maxTimestamp);
  writer.bytes(args.summary.oddsSubTreeRoot);
  writeProofVec(writer, args.subTreeProof);
  writeProofVec(writer, args.mainTreeProof);
  writer.u8(args.sideIndex);
  return ok(writer.finish());
};
