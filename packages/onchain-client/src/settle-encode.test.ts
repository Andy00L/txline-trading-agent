import { describe, expect, it } from 'vitest';
import type { RevealArgs } from './borsh.js';
import { encodeSettleArgs, type SettleArgsInput } from './settle-encode.js';

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

const fill = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

const reveal: RevealArgs = {
  strategy: fill(1),
  index: 1n,
  fixtureId: 17_588_227n,
  market: 0,
  side: 0,
  fairProbBps: 5263,
  entryOddsMilli: 2100,
  stake: 25_000_000n,
  signalHash: fill(7),
  nonce: fill(9),
};

const canonical: SettleArgsInput = {
  reveal,
  claimedResult: 0,
  ts: 1_750_000_000_000n,
  fixtureSummary: {
    fixtureId: 17_588_227n,
    updateStats: { updateCount: 5, minTimestamp: 1_750_000_000_000n, maxTimestamp: 1_750_000_300_000n },
    eventsSubTreeRoot: fill(10),
  },
  fixtureProof: [{ hash: fill(11), isRightSibling: true }],
  mainTreeProof: [{ hash: fill(12), isRightSibling: false }],
  statHome: {
    statToProve: { key: 1, value: 2, period: 0 },
    eventStatRoot: fill(13),
    statProof: [{ hash: fill(14), isRightSibling: true }],
  },
  statAway: {
    statToProve: { key: 2, value: 1, period: 0 },
    eventStatRoot: fill(13),
    statProof: [{ hash: fill(15), isRightSibling: false }],
  },
};

// Golden borsh from programs/agent_ledger/src/state.rs::print_canonical_settle_args.
const GOLDEN =
  '0101010101010101010101010101010101010101010101010101010101010101010000000000000003600c01000000000000008f143408000040787d0100000000070707070707070707070707070707070707070707070707070707070707070709090909090909090909090909090909090909090909090909090909090909090000dc20749701000003600c01000000000500000000dc207497010000e06f2574970100000a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010000000b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b01010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c000100000002000000000000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d010000000e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e010200000001000000000000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d010000000f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f00';

describe('encodeSettleArgs', () => {
  it('reproduces the on-chain SettleArgs borsh byte-for-byte', () => {
    const result = encodeSettleArgs(canonical);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toHex(result.value)).toBe(GOLDEN);
    }
  });

  it('errors on a wrong-length proof hash', () => {
    const result = encodeSettleArgs({
      ...canonical,
      fixtureProof: [{ hash: new Uint8Array(16), isRightSibling: true }],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a stat value beyond i32 instead of silently masking', () => {
    const result = encodeSettleArgs({
      ...canonical,
      statHome: { ...canonical.statHome, statToProve: { key: 1, value: 2 ** 31, period: 0 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('bad-range');
      expect(result.error.field).toBe('statHome.statToProve.value');
    }
  });

  it('rejects a claimed result outside 0/1/2', () => {
    const result = encodeSettleArgs({ ...canonical, claimedResult: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('claimedResult');
    }
  });
});
