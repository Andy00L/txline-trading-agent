import { err, ok, type Result } from '@txline-agent/core';
import { encodeRevealArgs, type EncodeError, type RevealArgs } from './borsh.js';
import { BorshWriter } from './borsh-writer.js';
import {
  COMMIT_DECISION_DISCRIMINATOR,
  SETTLE_DECISION_DISCRIMINATOR,
  VOID_DECISION_DISCRIMINATOR,
} from './discriminators.js';
import { encodeSettleArgs, type SettleArgsInput } from './settle-encode.js';

const withDiscriminator = (discriminator: Uint8Array, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(discriminator.length + body.length);
  out.set(discriminator, 0);
  out.set(body, discriminator.length);
  return out;
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

/** Instruction data for void_decision: discriminator ++ borsh(RevealArgs) ++ reason. */
export const encodeVoidDecisionData = (input: {
  readonly reveal: RevealArgs;
  readonly reason: number;
}): Result<Uint8Array, EncodeError> => {
  const reveal = encodeRevealArgs(input.reveal);
  if (!reveal.ok) {
    return reveal;
  }
  const writer = new BorshWriter();
  writer.bytes(reveal.value);
  writer.u8(input.reason);
  return ok(withDiscriminator(VOID_DECISION_DISCRIMINATOR, writer.finish()));
};
