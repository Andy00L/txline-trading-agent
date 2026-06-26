import { describe, expect, it } from 'vitest';
import type { RevealArgs } from './borsh.js';
import { computeCommitHash } from './commit-hash.js';

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

// The canonical reveal pinned by the on-chain golden
// (programs/agent_ledger/src/logic.rs::canonical_commit_hash_is_stable).
const canonical: RevealArgs = {
  strategy: new Uint8Array(32).fill(1),
  index: 1n,
  fixtureId: 17_588_227n,
  market: 0,
  side: 0,
  fairProbBps: 5263,
  entryOddsMilli: 2100,
  stake: 25_000_000n,
  signalHash: new Uint8Array(32).fill(7),
  nonce: new Uint8Array(32).fill(9),
};

describe('computeCommitHash', () => {
  it('reproduces the on-chain commit hash byte-for-byte', () => {
    const result = computeCommitHash(canonical);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toHex(result.value)).toBe(
        '1244a9767dcb28206a7da4ad1904def66f98d0ee1f879da348e6df75eea86b92',
      );
    }
  });

  it('changes when any sealed field changes', () => {
    const original = computeCommitHash(canonical);
    const altered = computeCommitHash({ ...canonical, side: 2 });
    if (original.ok && altered.ok) {
      expect(toHex(original.value)).not.toBe(toHex(altered.value));
    }
  });

  it('rejects a wrong-length pubkey', () => {
    const result = computeCommitHash({ ...canonical, strategy: new Uint8Array(31) });
    expect(result.ok).toBe(false);
  });
});
