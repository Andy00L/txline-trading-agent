import { describe, expect, it } from 'vitest';
import { encodeProveOddsArgs, type ProveOddsArgsInput } from './prove-odds-encode.js';

const filled = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

// The byte-for-byte mirror of programs/agent_ledger/src/state.rs canonical_prove_odds(): side
// HOME at index 0, price_names[0] = "1", prices[0] = 2100 = entry_odds_milli.
const canonical: ProveOddsArgsInput = {
  reveal: {
    strategy: filled(1),
    index: 1n,
    fixtureId: 17_588_227n,
    market: 0,
    side: 0,
    fairProbBps: 5263,
    entryOddsMilli: 2100,
    stake: 25_000_000n,
    signalHash: filled(7),
    nonce: filled(9),
  },
  ts: 1_750_000_000_000n,
  oddsSnapshot: {
    fixtureId: 17_588_227n,
    messageId: 'msg-1',
    ts: 1_750_000_000_000n,
    bookmaker: 'TXLineStablePriceDemargined',
    bookmakerId: 0,
    superOddsType: '1X2_PARTICIPANT_RESULT',
    gameState: null,
    inRunning: false,
    marketParameters: '',
    marketPeriod: null,
    priceNames: ['1', 'X', '2'],
    prices: [2100, 3400, 3600],
  },
  summary: {
    fixtureId: 17_588_227n,
    updateStats: {
      updateCount: 5,
      minTimestamp: 1_750_000_000_000n,
      maxTimestamp: 1_750_000_300_000n,
    },
    oddsSubTreeRoot: filled(13),
  },
  subTreeProof: [{ hash: filled(14), isRightSibling: true }],
  mainTreeProof: [{ hash: filled(15), isRightSibling: false }],
  sideIndex: 0,
};

// Pinned by the Rust golden state.rs::canonical_prove_odds_args_borsh_is_stable. The on-chain
// program deserializes exactly these bytes, so any drift in either encoder breaks the proof.
const EXPECTED_HEX =
  '0101010101010101010101010101010101010101010101010101010101010101010000000000000003600c01000000000000008f143408000040787d01000000000707070707070707070707070707070707070707070707070707070707070707090909090909090909090909090909090909090909090909090909090909090900dc20749701000003600c0100000000050000006d73672d3100dc2074970100001b00000054584c696e65537461626c65507269636544656d617267696e656400000000160000003158325f5041525449434950414e545f524553554c540000010000000000030000000100000031010000005801000000320300000034080000480d0000100e000003600c01000000000500000000dc207497010000e06f2574970100000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d010000000e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e01010000000f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0000';

describe('encodeProveOddsArgs', () => {
  it('reproduces the Rust borsh byte-for-byte (cross-language golden)', () => {
    const result = encodeProveOddsArgs(canonical);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toHex(result.value)).toBe(EXPECTED_HEX);
    }
  });

  it('range-checks a price that overflows an i32 rather than wrapping it silently', () => {
    const bad: ProveOddsArgsInput = {
      ...canonical,
      oddsSnapshot: { ...canonical.oddsSnapshot, prices: [2100, 3400, 3_000_000_000] },
    };
    const result = encodeProveOddsArgs(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('bad-range');
    }
  });

  it('rejects a side index that is not a u8', () => {
    const bad: ProveOddsArgsInput = { ...canonical, sideIndex: 300 };
    const result = encodeProveOddsArgs(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe('sideIndex');
    }
  });
});
