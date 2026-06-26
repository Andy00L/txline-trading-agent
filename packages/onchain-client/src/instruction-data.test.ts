import { describe, expect, it } from 'vitest';
import type { RevealArgs } from './borsh.js';
import { COMMIT_DECISION_DISCRIMINATOR, VOID_DECISION_DISCRIMINATOR } from './discriminators.js';
import { encodeCommitDecisionData, encodeVoidDecisionData } from './instruction-data.js';

const startsWith = (data: Uint8Array, prefix: Uint8Array): boolean =>
  prefix.every((byte, index) => data[index] === byte);

const reveal: RevealArgs = {
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

describe('encodeCommitDecisionData', () => {
  it('prefixes the commit discriminator and packs the args', () => {
    const result = encodeCommitDecisionData({
      commitHash: new Uint8Array(32).fill(5),
      fixtureId: 17_588_227n,
      market: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(startsWith(result.value, COMMIT_DECISION_DISCRIMINATOR)).toBe(true);
      expect(result.value).toHaveLength(8 + 32 + 8 + 2);
    }
  });

  it('rejects a wrong-length commit hash', () => {
    expect(
      encodeCommitDecisionData({ commitHash: new Uint8Array(31), fixtureId: 1n, market: 0 }).ok,
    ).toBe(false);
  });
});

describe('encodeVoidDecisionData', () => {
  it('prefixes the void discriminator and packs the reveal plus reason', () => {
    const result = encodeVoidDecisionData({ reveal, reason: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(startsWith(result.value, VOID_DECISION_DISCRIMINATOR)).toBe(true);
      expect(result.value).toHaveLength(8 + 129 + 1);
    }
  });
});
