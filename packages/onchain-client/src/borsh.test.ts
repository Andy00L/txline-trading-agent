import { describe, expect, it } from 'vitest';
import { encodeRevealArgs, type RevealArgs } from './borsh.js';

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

describe('encodeRevealArgs', () => {
  it('produces a 129-byte buffer with the fixed field layout', () => {
    const result = encodeRevealArgs(canonical);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(129);
      // strategy occupies the first 32 bytes
      expect(Array.from(result.value.subarray(0, 32))).toEqual(
        Array.from(new Uint8Array(32).fill(1)),
      );
      // index = 1 as u64 little-endian starts at offset 32
      expect(result.value[32]).toBe(1);
      expect(result.value[33]).toBe(0);
    }
  });

  it('reports a bad-length field', () => {
    const result = encodeRevealArgs({ ...canonical, nonce: new Uint8Array(16) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('nonce');
    }
  });

  it('rejects an out-of-range side instead of silently masking it', () => {
    const result = encodeRevealArgs({ ...canonical, side: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('bad-range');
      expect(result.error.field).toBe('side');
    }
  });

  it('rejects a u16 field above its width instead of wrapping', () => {
    const result = encodeRevealArgs({ ...canonical, market: 0x1_0000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('bad-range');
      expect(result.error.field).toBe('market');
    }
  });

  it('rejects a negative u64 stake', () => {
    const result = encodeRevealArgs({ ...canonical, stake: -1n });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('stake');
    }
  });
});
