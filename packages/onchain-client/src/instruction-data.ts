import { err, ok, type Result } from '@txline-agent/core';
import { encodeRevealArgs, type EncodeError, type RevealArgs } from './borsh.js';
import { BorshWriter } from './borsh-writer.js';
import {
  COMMIT_DECISION_DISCRIMINATOR,
  INITIALIZE_STRATEGY_DISCRIMINATOR,
  PROVE_ENTRY_ODDS_DISCRIMINATOR,
  SETTLE_DECISION_DISCRIMINATOR,
  VOID_DECISION_DISCRIMINATOR,
} from './discriminators.js';
import { encodeSettleArgs, type SettleArgsInput } from './settle-encode.js';
import { encodeProveOddsArgs, type ProveOddsArgsInput } from './prove-odds-encode.js';
import { checkI64, checkU8, checkU16, checkU64 } from './int-range.js';

const withDiscriminator = (discriminator: Uint8Array, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(discriminator.length + body.length);
  out.set(discriminator, 0);
  out.set(body, discriminator.length);
  return out;
};

/**
 * Instruction data for initialize_strategy: discriminator ++ strategy_id ++
 * txline_program ++ starting_bankroll. The arg order mirrors the Rust handler
 * signature (programs/agent_ledger/src/lib.rs initialize_strategy). txlineProgram
 * is the pinned CPI target written verbatim as a 32-byte pubkey.
 */
export const encodeInitializeStrategyData = (input: {
  readonly strategyId: bigint;
  readonly txlineProgram: Uint8Array;
  readonly startingBankroll: bigint;
}): Result<Uint8Array, EncodeError> => {
  if (input.txlineProgram.length !== 32) {
    return err({
      kind: 'bad-length',
      field: 'txlineProgram',
      detail: `expected 32 bytes, got ${input.txlineProgram.length}`,
    });
  }
  const rangeFailure =
    checkU64(input.strategyId, 'strategyId') ?? checkU64(input.startingBankroll, 'startingBankroll');
  if (rangeFailure !== null) {
    return err(rangeFailure);
  }
  const writer = new BorshWriter();
  writer.u64(input.strategyId);
  writer.bytes(input.txlineProgram);
  writer.u64(input.startingBankroll);
  return ok(withDiscriminator(INITIALIZE_STRATEGY_DISCRIMINATOR, writer.finish()));
};

/** Instruction data for commit_decision: discriminator ++ commit_hash ++ fixture_id ++ market. */
export const encodeCommitDecisionData = (input: {
  readonly commitHash: Uint8Array;
  readonly fixtureId: bigint;
  readonly market: number;
}): Result<Uint8Array, EncodeError> => {
  if (input.commitHash.length !== 32) {
    return err({
      kind: 'bad-length',
      field: 'commitHash',
      detail: `expected 32 bytes, got ${input.commitHash.length}`,
    });
  }
  const rangeFailure = checkI64(input.fixtureId, 'fixtureId') ?? checkU16(input.market, 'market');
  if (rangeFailure !== null) {
    return err(rangeFailure);
  }
  const writer = new BorshWriter();
  writer.bytes(input.commitHash);
  writer.i64(input.fixtureId);
  writer.u16(input.market);
  return ok(withDiscriminator(COMMIT_DECISION_DISCRIMINATOR, writer.finish()));
};

/** Instruction data for settle_decision: discriminator ++ borsh(SettleArgs). */
export const encodeSettleDecisionData = (args: SettleArgsInput): Result<Uint8Array, EncodeError> => {
  const encoded = encodeSettleArgs(args);
  if (!encoded.ok) {
    return encoded;
  }
  return ok(withDiscriminator(SETTLE_DECISION_DISCRIMINATOR, encoded.value));
};

/** Instruction data for prove_entry_odds: discriminator ++ borsh(ProveOddsArgs). */
export const encodeProveEntryOddsData = (
  args: ProveOddsArgsInput,
): Result<Uint8Array, EncodeError> => {
  const encoded = encodeProveOddsArgs(args);
  if (!encoded.ok) {
    return encoded;
  }
  return ok(withDiscriminator(PROVE_ENTRY_ODDS_DISCRIMINATOR, encoded.value));
};

/** Instruction data for void_decision: discriminator ++ borsh(RevealArgs) ++ reason. */
export const encodeVoidDecisionData = (input: {
  readonly reveal: RevealArgs;
  readonly reason: number;
}): Result<Uint8Array, EncodeError> => {
  const reveal = encodeRevealArgs(input.reveal);
  if (!reveal.ok) {
    return reveal;
  }
  const reasonFailure = checkU8(input.reason, 'reason');
  if (reasonFailure !== null) {
    return err(reasonFailure);
  }
  const writer = new BorshWriter();
  writer.bytes(reveal.value);
  writer.u8(input.reason);
  return ok(withDiscriminator(VOID_DECISION_DISCRIMINATOR, writer.finish()));
};
