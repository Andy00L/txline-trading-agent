import { describe, expect, it } from 'vitest';
import type { RevealArgs } from './borsh.js';
import { encodeSettleArgs } from './settle-encode.js';
import { buildSettleArgs, bytesFromByteArray, type StatValidationInput } from './settle-args.js';

// A 32-byte array of one repeated byte (the wire form), matching the byte fills used in
// the Rust canonical_settle golden (programs/agent_ledger/src/state.rs).
const fill = (byte: number): number[] => Array.from({ length: 32 }, () => byte);

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

// The exact borsh the on-chain SettleArgs serializes for the canonical inputs. This is
// the cross-language golden pinned by the Rust test canonical_settle_args_borsh_is_stable
// and by settle-encode.test.ts; building it through the wire-shape bridge must reproduce it.
const CANONICAL_SETTLE_BORSH_HEX =
  '0101010101010101010101010101010101010101010101010101010101010101010000000000000003600c01000000000000008f143408000040787d0100000000070707070707070707070707070707070707070707070707070707070707070709090909090909090909090909090909090909090909090909090909090909090000dc20749701000003600c01000000000500000000dc207497010000e06f2574970100000a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010000000b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b01010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c000100000002000000000000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d010000000e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e010200000001000000000000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d010000000f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f00';

const canonicalReveal = (): RevealArgs => ({
  strategy: new Uint8Array(32).fill(1),
  index: 1n,
  fixtureId: 17_588_227n,
  market: 0,
  side: 0, // SIDE_HOME
  fairProbBps: 5263,
  entryOddsMilli: 2100,
  stake: 25_000_000n,
  signalHash: new Uint8Array(32).fill(7),
  nonce: new Uint8Array(32).fill(9),
});

const canonicalValidation = (): StatValidationInput => ({
  ts: 1_750_000_000_000,
  statToProve: { key: 1, value: 2, period: 0 },
  eventStatRoot: fill(0x0d),
  summary: {
    fixtureId: 17_588_227,
    updateStats: {
      updateCount: 5,
      minTimestamp: 1_750_000_000_000,
      maxTimestamp: 1_750_000_300_000,
    },
    eventStatsSubTreeRoot: fill(0x0a),
  },
  statProof: [{ hash: fill(0x0e), isRightSibling: true }],
  subTreeProof: [{ hash: fill(0x0b), isRightSibling: true }],
  mainTreeProof: [{ hash: fill(0x0c), isRightSibling: false }],
  statToProve2: { key: 2, value: 1, period: 0 },
  statProof2: [{ hash: fill(0x0f), isRightSibling: false }],
});

describe('buildSettleArgs', () => {
  it('reproduces the on-chain canonical SettleArgs borsh from the wire proof shape', () => {
    const built = buildSettleArgs({
      validation: canonicalValidation(),
      reveal: canonicalReveal(),
      claimedResult: 0,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const encoded = encodeSettleArgs(built.value);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) {
      return;
    }
    expect(toHex(encoded.value)).toBe(CANONICAL_SETTLE_BORSH_HEX);
  });

  it('maps a null proof branch to an empty vector', () => {
    const validation: StatValidationInput = { ...canonicalValidation(), subTreeProof: null };
    const built = buildSettleArgs({ validation, reveal: canonicalReveal(), claimedResult: 0 });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    expect(built.value.fixtureProof).toHaveLength(0);
  });

  it('rejects a single-stat proof: a 1X2 settle needs the away stat', () => {
    const validation: StatValidationInput = { ...canonicalValidation() };
    const stripped: StatValidationInput = {
      ts: validation.ts,
      statToProve: validation.statToProve,
      eventStatRoot: validation.eventStatRoot,
      summary: validation.summary,
      statProof: validation.statProof,
      subTreeProof: validation.subTreeProof,
      mainTreeProof: validation.mainTreeProof,
    };
    const built = buildSettleArgs({ validation: stripped, reveal: canonicalReveal(), claimedResult: 0 });
    expect(built.ok).toBe(false);
    if (built.ok) {
      return;
    }
    expect(built.error.kind).toBe('missing-second-stat');
  });

  it('rejects a malformed hash', () => {
    const validation: StatValidationInput = { ...canonicalValidation(), eventStatRoot: [1, 2, 3] };
    const built = buildSettleArgs({ validation, reveal: canonicalReveal(), claimedResult: 0 });
    expect(built.ok).toBe(false);
    if (built.ok) {
      return;
    }
    expect(built.error.kind).toBe('bad-hash');
  });
});

describe('bytesFromByteArray', () => {
  it('converts a 32-byte array', () => {
    const input = Array.from({ length: 32 }, (_unused, index) => index);
    const result = bytesFromByteArray(input, 'h');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Array.from(result.value)).toEqual(input);
  });

  it('rejects a wrong-length array', () => {
    expect(bytesFromByteArray([1, 2, 3], 'h').ok).toBe(false);
  });

  it('rejects out-of-range bytes', () => {
    expect(bytesFromByteArray(Array.from({ length: 32 }, () => 300), 'h').ok).toBe(false);
  });
});
