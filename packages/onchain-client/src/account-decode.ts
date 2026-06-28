import { err, ok, type Result } from '@txline-agent/core';
import { sha256 } from '@noble/hashes/sha256';

/**
 * Decoders for the agent_ledger account state. Layouts mirror
 * programs/agent_ledger/src/state.rs field for field; the leading 8 bytes are the
 * Anchor account discriminator (sha256("account:<Name>")[0..8]), which is verified
 * so decoding the wrong account type fails loudly instead of returning garbage.
 */
const ANCHOR_DISCRIMINATOR_SIZE = 8;

const accountDiscriminator = (name: string): Uint8Array =>
  sha256(new TextEncoder().encode(`account:${name}`)).slice(0, ANCHOR_DISCRIMINATOR_SIZE);

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
};

export type DecodeAccountError =
  | { readonly kind: 'too-short'; readonly account: string; readonly detail: string }
  | { readonly kind: 'wrong-discriminator'; readonly account: string; readonly detail: string };

export type StrategyAccount = {
  readonly authority: Uint8Array;
  readonly strategyId: bigint;
  readonly txlineProgram: Uint8Array;
  readonly startingBankroll: bigint;
  readonly bankroll: bigint;
  readonly realizedPnl: bigint;
  readonly decisionsCount: bigint;
  readonly openCount: bigint;
  readonly settledCount: bigint;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly commitLogRoot: Uint8Array;
  readonly bump: number;
};

export type DecisionCommitAccount = {
  readonly strategy: Uint8Array;
  readonly index: bigint;
  readonly commitHash: Uint8Array;
  readonly fixtureId: bigint;
  readonly market: number;
  readonly commitSlot: bigint;
  readonly commitUnixTs: bigint;
  readonly status: number;
  readonly outcomeSide: number;
  readonly pnl: bigint;
  readonly settleSlot: bigint;
  /** Set once prove_entry_odds binds the sealed entry odds to a proven in-tree price. */
  readonly entryOddsProven: boolean;
  readonly bump: number;
};

// Decision lifecycle, mirroring state.rs STATUS_* constants.
export const STATUS_OPEN = 0;
export const STATUS_SETTLED = 1;
export const STATUS_VOID = 2;

// Body sizes after the 8-byte discriminator (state.rs InitSpace layout).
// Strategy: 32+8+32+8+8+8+8+8+8+4+4+4+32+1 = 165.
const STRATEGY_BODY_SIZE = 165;
// DecisionCommit: 32+8+32+8+2+8+8+1+1+8+8+1+1 (the trailing entry_odds_proven bool then bump).
const DECISION_COMMIT_BODY_SIZE = 118;

class BorshReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  skip(count: number): void {
    this.offset += count;
  }

  bytes(count: number): Uint8Array {
    const slice = this.data.slice(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  i64(): bigint {
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }
}

const checkAccount = (
  data: Uint8Array,
  name: string,
  bodySize: number,
): DecodeAccountError | null => {
  const expected = ANCHOR_DISCRIMINATOR_SIZE + bodySize;
  if (data.length < expected) {
    return { kind: 'too-short', account: name, detail: `expected >= ${expected} bytes, got ${data.length}` };
  }
  if (!bytesEqual(data.slice(0, ANCHOR_DISCRIMINATOR_SIZE), accountDiscriminator(name))) {
    return { kind: 'wrong-discriminator', account: name, detail: `leading 8 bytes are not the ${name} discriminator` };
  }
  return null;
};

/** Decode a Strategy account; the on-chain decisions_count is the next commit index. */
export const decodeStrategyAccount = (data: Uint8Array): Result<StrategyAccount, DecodeAccountError> => {
  const failure = checkAccount(data, 'Strategy', STRATEGY_BODY_SIZE);
  if (failure) {
    return err(failure);
  }
  const reader = new BorshReader(data);
  reader.skip(ANCHOR_DISCRIMINATOR_SIZE);
  return ok({
    authority: reader.bytes(32),
    strategyId: reader.u64(),
    txlineProgram: reader.bytes(32),
    startingBankroll: reader.u64(),
    bankroll: reader.u64(),
    realizedPnl: reader.i64(),
    decisionsCount: reader.u64(),
    openCount: reader.u64(),
    settledCount: reader.u64(),
    wins: reader.u32(),
    losses: reader.u32(),
    pushes: reader.u32(),
    commitLogRoot: reader.bytes(32),
    bump: reader.u8(),
  });
};

/** Decode a DecisionCommit account; status, outcomeSide, and pnl are set at settle. */
export const decodeDecisionCommitAccount = (
  data: Uint8Array,
): Result<DecisionCommitAccount, DecodeAccountError> => {
  const failure = checkAccount(data, 'DecisionCommit', DECISION_COMMIT_BODY_SIZE);
  if (failure) {
    return err(failure);
  }
  const reader = new BorshReader(data);
  reader.skip(ANCHOR_DISCRIMINATOR_SIZE);
  return ok({
    strategy: reader.bytes(32),
    index: reader.u64(),
    commitHash: reader.bytes(32),
    fixtureId: reader.i64(),
    market: reader.u16(),
    commitSlot: reader.u64(),
    commitUnixTs: reader.i64(),
    status: reader.u8(),
    outcomeSide: reader.u8(),
    pnl: reader.i64(),
    settleSlot: reader.u64(),
    entryOddsProven: reader.u8() === 1,
    bump: reader.u8(),
  });
};
