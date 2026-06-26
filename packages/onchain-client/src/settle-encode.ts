import { err, ok, type Result } from '@txline-agent/core';
import { encodeRevealArgs, type EncodeError, type RevealArgs } from './borsh.js';
import { BorshWriter } from './borsh-writer.js';

export type ScoreStatInput = { readonly key: number; readonly value: number; readonly period: number };
export type ProofNodeInput = { readonly hash: Uint8Array; readonly isRightSibling: boolean };
export type StatTermInput = {
  readonly statToProve: ScoreStatInput;
  readonly eventStatRoot: Uint8Array;
  readonly statProof: readonly ProofNodeInput[];
};
export type ScoresUpdateStatsInput = {
  readonly updateCount: number;
  readonly minTimestamp: bigint;
  readonly maxTimestamp: bigint;
};
export type ScoresBatchSummaryInput = {
  readonly fixtureId: bigint;
  readonly updateStats: ScoresUpdateStatsInput;
  readonly eventsSubTreeRoot: Uint8Array;
};

/** Mirror of the on-chain SettleArgs (programs/agent_ledger/src/state.rs). */
export type SettleArgsInput = {
  readonly reveal: RevealArgs;
  readonly claimedResult: number;
  readonly ts: bigint;
  readonly fixtureSummary: ScoresBatchSummaryInput;
  readonly fixtureProof: readonly ProofNodeInput[];
  readonly mainTreeProof: readonly ProofNodeInput[];
  readonly statHome: StatTermInput;
  readonly statAway: StatTermInput;
};

const ensure32 = (bytes: Uint8Array, field: string): EncodeError | null =>
  bytes.length === 32
    ? null
    : { kind: 'bad-length', field, detail: `expected 32 bytes, got ${bytes.length}` };

const checkProof = (proof: readonly ProofNodeInput[], label: string): EncodeError | null => {
  for (let index = 0; index < proof.length; index += 1) {
    const node = proof[index];
    if (node) {
      const failure = ensure32(node.hash, `${label}[${index}].hash`);
      if (failure) {
        return failure;
      }
    }
  }
  return null;
};

const checkStatTerm = (term: StatTermInput, label: string): EncodeError | null =>
  ensure32(term.eventStatRoot, `${label}.eventStatRoot`) ??
  checkProof(term.statProof, `${label}.statProof`);

const writeProofVec = (writer: BorshWriter, proof: readonly ProofNodeInput[]): void => {
  writer.vecLen(proof.length);
  for (const node of proof) {
    writer.bytes(node.hash);
    writer.bool(node.isRightSibling);
  }
};

const writeStatTerm = (writer: BorshWriter, term: StatTermInput): void => {
  writer.u32(term.statToProve.key);
  writer.i32(term.statToProve.value);
  writer.i32(term.statToProve.period);
  writer.bytes(term.eventStatRoot);
  writeProofVec(writer, term.statProof);
};

/** Borsh-encode SettleArgs for the settle_decision instruction data (after the
 * discriminator). Byte-identical to the Rust struct; pinned by a golden test. */
export const encodeSettleArgs = (args: SettleArgsInput): Result<Uint8Array, EncodeError> => {
  const reveal = encodeRevealArgs(args.reveal);
  if (!reveal.ok) {
    return reveal;
  }
  const failure =
    ensure32(args.fixtureSummary.eventsSubTreeRoot, 'fixtureSummary.eventsSubTreeRoot') ??
    checkProof(args.fixtureProof, 'fixtureProof') ??
    checkProof(args.mainTreeProof, 'mainTreeProof') ??
    checkStatTerm(args.statHome, 'statHome') ??
    checkStatTerm(args.statAway, 'statAway');
  if (failure) {
    return err(failure);
  }

  const writer = new BorshWriter();
  writer.bytes(reveal.value);
  writer.u8(args.claimedResult);
  writer.i64(args.ts);
  writer.i64(args.fixtureSummary.fixtureId);
  writer.i32(args.fixtureSummary.updateStats.updateCount);
  writer.i64(args.fixtureSummary.updateStats.minTimestamp);
  writer.i64(args.fixtureSummary.updateStats.maxTimestamp);
  writer.bytes(args.fixtureSummary.eventsSubTreeRoot);
  writeProofVec(writer, args.fixtureProof);
  writeProofVec(writer, args.mainTreeProof);
  writeStatTerm(writer, args.statHome);
  writeStatTerm(writer, args.statAway);
  return ok(writer.finish());
};
