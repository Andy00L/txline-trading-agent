import { err, ok, type Result } from '@txline-agent/core';

/**
 * Mirror of the on-chain RevealArgs (programs/agent_ledger/src/state.rs). The borsh
 * byte layout must match the Rust struct exactly, field by field, because the
 * commit-reveal binding is keccak256 over these bytes. A cross-language golden test
 * (commit-hash.test.ts) pins it against the value the program produces.
 */
export type RevealArgs = {
  readonly strategy: Uint8Array; // 32-byte pubkey
  readonly index: bigint; // u64
  readonly fixtureId: bigint; // i64
  readonly market: number; // u16
  readonly side: number; // u8
  readonly fairProbBps: number; // u16
  readonly entryOddsMilli: number; // u32
  readonly stake: bigint; // u64
  readonly signalHash: Uint8Array; // 32 bytes
  readonly nonce: Uint8Array; // 32 bytes
};

// 32 + 8 + 8 + 2 + 1 + 2 + 4 + 8 + 32 + 32.
const REVEAL_ARGS_SIZE = 129;

export type EncodeError = { readonly kind: 'bad-length'; readonly field: string; readonly detail: string };

const badLength = (field: string, actual: number): EncodeError => ({
  kind: 'bad-length',
  field,
  detail: `expected 32 bytes, got ${actual}`,
});

/** Borsh-encode RevealArgs to the exact byte layout the on-chain program hashes. */
export const encodeRevealArgs = (reveal: RevealArgs): Result<Uint8Array, EncodeError> => {
  if (reveal.strategy.length !== 32) {
    return err(badLength('strategy', reveal.strategy.length));
  }
  if (reveal.signalHash.length !== 32) {
    return err(badLength('signalHash', reveal.signalHash.length));
  }
  if (reveal.nonce.length !== 32) {
    return err(badLength('nonce', reveal.nonce.length));
  }

  const buffer = new Uint8Array(REVEAL_ARGS_SIZE);
  const view = new DataView(buffer.buffer);
  let offset = 0;
  buffer.set(reveal.strategy, offset);
  offset += 32;
  view.setBigUint64(offset, reveal.index, true);
  offset += 8;
  view.setBigInt64(offset, reveal.fixtureId, true);
  offset += 8;
  view.setUint16(offset, reveal.market, true);
  offset += 2;
  view.setUint8(offset, reveal.side);
  offset += 1;
  view.setUint16(offset, reveal.fairProbBps, true);
  offset += 2;
  view.setUint32(offset, reveal.entryOddsMilli, true);
  offset += 4;
  view.setBigUint64(offset, reveal.stake, true);
  offset += 8;
  buffer.set(reveal.signalHash, offset);
  offset += 32;
  buffer.set(reveal.nonce, offset);
  return ok(buffer);
};
