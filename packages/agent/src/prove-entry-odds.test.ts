import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from '@txline-agent/core';
import type { OnChainError, ProveOddsArgsInput, RevealArgs } from '@txline-agent/onchain-client';
import type { OddsPayload, OddsValidation, TxlineError } from '@txline-agent/txline';
import {
  proveEntryOddsForReveal,
  type EntryOddsProvePort,
  type OddsProofSource,
} from './prove-entry-odds.js';

const FIXTURE_ID = 17_588_302;
const ENTRY_ODDS_MILLI = 2100;
const ANCHOR_TS = 1_700_000_000_000;
const ROOT_32 = Array.from({ length: 32 }, (_unused, index) => index);

// A sealed reveal backing the home side (0) at 2.100. Only fixtureId, side, and entryOddsMilli
// drive the discovery; the rest are placeholders.
const reveal: RevealArgs = {
  strategy: new Uint8Array(32),
  index: 7n,
  fixtureId: BigInt(FIXTURE_ID),
  market: 0,
  side: 0,
  fairProbBps: 5000,
  entryOddsMilli: ENTRY_ODDS_MILLI,
  stake: 25_000_000n,
  signalHash: new Uint8Array(32),
  nonce: new Uint8Array(32),
};

const oneX2Record = (prices: readonly number[]): OddsPayload => ({
  FixtureId: FIXTURE_ID,
  MessageId: 'msg-1',
  Ts: ANCHOR_TS,
  Bookmaker: 'TXLineStablePriceDemargined',
  BookmakerId: 1,
  SuperOddsType: '1X2_PARTICIPANT_RESULT',
  InRunning: false,
  PriceNames: ['part1', 'draw', 'part2'],
  Prices: [...prices],
});

const oddsValidationFor = (prices: readonly number[]): OddsValidation => ({
  odds: {
    FixtureId: FIXTURE_ID,
    MessageId: 'msg-1',
    Ts: ANCHOR_TS,
    Bookmaker: 'TXLineStablePriceDemargined',
    BookmakerId: 1,
    SuperOddsType: '1X2_PARTICIPANT_RESULT',
    InRunning: false,
    PriceNames: ['part1', 'draw', 'part2'],
    Prices: [...prices],
  },
  summary: {
    fixtureId: FIXTURE_ID,
    updateStats: { updateCount: 1, minTimestamp: ANCHOR_TS, maxTimestamp: ANCHOR_TS },
    oddsSubTreeRoot: ROOT_32,
  },
  subTreeProof: [],
  mainTreeProof: [],
});

class FakeOddsProofs implements OddsProofSource {
  updates: readonly OddsPayload[] = [oneX2Record([ENTRY_ODDS_MILLI, 3000, 4000])];
  validation: OddsValidation = oddsValidationFor([ENTRY_ODDS_MILLI, 3000, 4000]);
  validationError: TxlineError | null = null;

  async getOddsUpdates(): Promise<Result<readonly OddsPayload[], TxlineError>> {
    return ok(this.updates);
  }

  async getOddsValidation(): Promise<Result<OddsValidation, TxlineError>> {
    if (this.validationError) {
      return err(this.validationError);
    }
    return ok(this.validation);
  }
}

class FakeProvePort implements EntryOddsProvePort {
  proven = true;
  reverted: OnChainError | null = null;
  calls = 0;
  lastArgs: ProveOddsArgsInput | null = null;

  async proveEntryOdds(request: {
    readonly index: bigint;
    readonly proveOddsArgs: ProveOddsArgsInput;
  }): Promise<Result<{ readonly txSig: string; readonly proven: boolean }, OnChainError>> {
    this.calls += 1;
    this.lastArgs = request.proveOddsArgs;
    if (this.reverted) {
      return err(this.reverted);
    }
    return ok({ txSig: 'odds-proof-sig', proven: this.proven });
  }
}

describe('proveEntryOddsForReveal', () => {
  it('proves the entry odds when a 1X2 record matches the sealed price for the side', async () => {
    const oddsProofs = new FakeOddsProofs();
    const port = new FakeProvePort();
    const outcome = await proveEntryOddsForReveal({ oddsProofs, port }, { reveal, index: 7n, anchorTs: ANCHOR_TS });
    expect(outcome.kind).toBe('proven');
    expect(port.calls).toBe(1);
    // part1 is column 0, so the prove args carry sideIndex 0 for the home side.
    expect(port.lastArgs?.sideIndex).toBe(0);
    if (outcome.kind === 'proven') {
      expect(outcome.txSig).toBe('odds-proof-sig');
    }
  });

  it('skips without failing when no record matches the sealed price in the window', async () => {
    const oddsProofs = new FakeOddsProofs();
    // The home price differs from the sealed 2100, so there is no record to prove.
    oddsProofs.updates = [oneX2Record([1999, 3000, 4000])];
    const port = new FakeProvePort();
    const outcome = await proveEntryOddsForReveal({ oddsProofs, port }, { reveal, index: 7n, anchorTs: ANCHOR_TS });
    expect(outcome.kind).toBe('skipped');
    expect(port.calls).toBe(0);
  });

  it('reports failed when the prove transaction reverts', async () => {
    const oddsProofs = new FakeOddsProofs();
    const port = new FakeProvePort();
    port.reverted = { kind: 'rpc', detail: 'node down' };
    const outcome = await proveEntryOddsForReveal({ oddsProofs, port }, { reveal, index: 7n, anchorTs: ANCHOR_TS });
    expect(outcome.kind).toBe('failed');
  });
});
