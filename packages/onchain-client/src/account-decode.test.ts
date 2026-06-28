import { sha256 } from '@noble/hashes/sha256';
import { describe, expect, it } from 'vitest';
import { BorshWriter } from './borsh-writer.js';
import {
  decodeDecisionCommitAccount,
  decodeStrategyAccount,
  STATUS_SETTLED,
} from './account-decode.js';

// The Anchor account discriminator, recomputed independently of the module under test.
const accountDiscriminator = (name: string): Uint8Array =>
  sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8);

const withDiscriminator = (name: string, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(8 + body.length);
  out.set(accountDiscriminator(name), 0);
  out.set(body, 8);
  return out;
};

const buildStrategyBody = (): Uint8Array => {
  const writer = new BorshWriter();
  writer.bytes(new Uint8Array(32).fill(2)); // authority
  writer.u64(7n); // strategy_id
  writer.bytes(new Uint8Array(32).fill(3)); // txline_program
  writer.u64(1_000_000_000n); // starting_bankroll
  writer.u64(1_050_000_000n); // bankroll
  writer.i64(-25_000_000n); // realized_pnl (signed)
  writer.u64(4n); // decisions_count
  writer.u64(1n); // open_count
  writer.u64(3n); // settled_count
  writer.u32(2); // wins
  writer.u32(1); // losses
  writer.u32(0); // pushes
  writer.bytes(new Uint8Array(32).fill(5)); // commit_log_root
  writer.u8(254); // bump
  return writer.finish();
};

const buildDecisionCommitBody = (): Uint8Array => {
  const writer = new BorshWriter();
  writer.bytes(new Uint8Array(32).fill(2)); // strategy
  writer.u64(1n); // index
  writer.bytes(new Uint8Array(32).fill(6)); // commit_hash
  writer.i64(17_588_227n); // fixture_id
  writer.u16(0); // market
  writer.u64(100n); // commit_slot
  writer.i64(1_750_000_000n); // commit_unix_ts
  writer.u8(STATUS_SETTLED); // status
  writer.u8(2); // outcome_side (away)
  writer.i64(-25_000_000n); // pnl (a loss, signed)
  writer.u64(200n); // settle_slot
  writer.u8(1); // entry_odds_proven (true)
  writer.u8(253); // bump
  return writer.finish();
};

describe('decodeStrategyAccount', () => {
  it('reads every field including signed pnl', () => {
    const data = withDiscriminator('Strategy', buildStrategyBody());
    const decoded = decodeStrategyAccount(data);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value.strategyId).toBe(7n);
    expect(decoded.value.bankroll).toBe(1_050_000_000n);
    expect(decoded.value.realizedPnl).toBe(-25_000_000n);
    expect(decoded.value.decisionsCount).toBe(4n);
    expect(decoded.value.wins).toBe(2);
    expect(decoded.value.bump).toBe(254);
    expect(Array.from(decoded.value.authority)).toEqual(Array.from(new Uint8Array(32).fill(2)));
  });

  it('rejects a wrong discriminator', () => {
    const data = new Uint8Array(8 + buildStrategyBody().length); // all-zero discriminator
    data.set(buildStrategyBody(), 8);
    const decoded = decodeStrategyAccount(data);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) {
      return;
    }
    expect(decoded.error.kind).toBe('wrong-discriminator');
  });

  it('rejects a too-short buffer', () => {
    const decoded = decodeStrategyAccount(new Uint8Array(10));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) {
      return;
    }
    expect(decoded.error.kind).toBe('too-short');
  });
});

describe('decodeDecisionCommitAccount', () => {
  it('reads the settled status, side, and signed pnl', () => {
    const data = withDiscriminator('DecisionCommit', buildDecisionCommitBody());
    const decoded = decodeDecisionCommitAccount(data);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value.index).toBe(1n);
    expect(decoded.value.fixtureId).toBe(17_588_227n);
    expect(decoded.value.status).toBe(STATUS_SETTLED);
    expect(decoded.value.outcomeSide).toBe(2);
    expect(decoded.value.pnl).toBe(-25_000_000n);
    expect(decoded.value.settleSlot).toBe(200n);
    expect(decoded.value.entryOddsProven).toBe(true);
    expect(decoded.value.bump).toBe(253);
  });
});
