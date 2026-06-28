import { describe, expect, it } from 'vitest';
import { buildProveOddsArgs, type OddsValidationInput } from './prove-odds-args.js';
import { encodeProveOddsArgs } from './prove-odds-encode.js';
import type { RevealArgs } from './borsh.js';

const filledArray = (byte: number): number[] => new Array<number>(32).fill(byte);
const filledBytes = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const reveal: RevealArgs = {
  strategy: filledBytes(1),
  index: 1n,
  fixtureId: 17_588_227n,
  market: 0,
  side: 0,
  fairProbBps: 5263,
  entryOddsMilli: 2100,
  stake: 25_000_000n,
  signalHash: filledBytes(7),
  nonce: filledBytes(9),
};

// A wire odds-validation proof that mirrors state.rs canonical_prove_odds(): the JSON-number byte
// arrays for the root and proof hashes, the PascalCase Odds snapshot, and the camelCase summary.
const validation: OddsValidationInput = {
  odds: {
    FixtureId: 17_588_227,
    MessageId: 'msg-1',
    Ts: 1_750_000_000_000,
    Bookmaker: 'TXLineStablePriceDemargined',
    BookmakerId: 0,
    SuperOddsType: '1X2_PARTICIPANT_RESULT',
    InRunning: false,
    MarketParameters: '',
    PriceNames: ['1', 'X', '2'],
    Prices: [2100, 3400, 3600],
  },
  summary: {
    fixtureId: 17_588_227,
    updateStats: { updateCount: 5, minTimestamp: 1_750_000_000_000, maxTimestamp: 1_750_000_300_000 },
    oddsSubTreeRoot: filledArray(13),
  },
  subTreeProof: [{ hash: filledArray(14), isRightSibling: true }],
  mainTreeProof: [{ hash: filledArray(15), isRightSibling: false }],
};

const EXPECTED_HEX =
  '0101010101010101010101010101010101010101010101010101010101010101010000000000000003600c01000000000000008f143408000040787d01000000000707070707070707070707070707070707070707070707070707070707070707090909090909090909090909090909090909090909090909090909090909090900dc20749701000003600c0100000000050000006d73672d3100dc2074970100001b00000054584c696e65537461626c65507269636544656d617267696e656400000000160000003158325f5041525449434950414e545f524553554c540000010000000000030000000100000031010000005801000000320300000034080000480d0000100e000003600c01000000000500000000dc207497010000e06f2574970100000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d010000000e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e01010000000f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0000';

describe('buildProveOddsArgs', () => {
  it('converts a wire odds-validation proof into args that encode to the Rust golden', () => {
    const built = buildProveOddsArgs({ validation, reveal, sideIndex: 0 });
    expect(built.ok).toBe(true);
    if (built.ok) {
      const encoded = encodeProveOddsArgs(built.value);
      expect(encoded.ok).toBe(true);
      if (encoded.ok) {
        expect(toHex(encoded.value)).toBe(EXPECTED_HEX);
      }
    }
  });

  it('rejects a Merkle root that is not 32 bytes', () => {
    const bad: OddsValidationInput = {
      ...validation,
      summary: { ...validation.summary, oddsSubTreeRoot: [1, 2, 3] },
    };
    const built = buildProveOddsArgs({ validation: bad, reveal, sideIndex: 0 });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.kind).toBe('bad-hash');
    }
  });
});
