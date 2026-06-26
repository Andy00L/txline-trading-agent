import { AccountRole, address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import type { RevealArgs } from './borsh.js';
import {
  COMMIT_DECISION_DISCRIMINATOR,
  INITIALIZE_STRATEGY_DISCRIMINATOR,
  SETTLE_DECISION_DISCRIMINATOR,
} from './discriminators.js';
import {
  buildCommitDecisionInstruction,
  buildInitializeStrategyInstruction,
  buildSetComputeUnitLimitInstruction,
  buildSettleDecisionInstruction,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  DEFAULT_COMPUTE_UNIT_LIMIT,
  SYSTEM_PROGRAM_ADDRESS,
} from './instruction-build.js';
import { deriveCommitPda, deriveStrategyPda } from './pda.js';
import type { SettleArgsInput } from './settle-encode.js';

const PROGRAM = address('FLZiKMUaPAGMtPLbfHvHwfiVfkTZD8RZ84CSrkDy1kLD');
const AUTHORITY = address('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
const TXORACLE = address('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
const ROOTS = address('4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG');

const startsWith = (data: ArrayLike<number> | undefined, prefix: Uint8Array): boolean => {
  if (!data || data.length < prefix.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[index] !== prefix[index]) {
      return false;
    }
  }
  return true;
};

const sampleReveal = (): RevealArgs => ({
  strategy: new Uint8Array(32).fill(1),
  index: 0n,
  fixtureId: 17_588_227n,
  market: 0,
  side: 0,
  fairProbBps: 5000,
  entryOddsMilli: 2000,
  stake: 100n,
  signalHash: new Uint8Array(32).fill(2),
  nonce: new Uint8Array(32).fill(3),
});

const sampleSettleArgs = (): SettleArgsInput => ({
  reveal: sampleReveal(),
  claimedResult: 0,
  ts: 1_750_000_000_000n,
  fixtureSummary: {
    fixtureId: 17_588_227n,
    updateStats: { updateCount: 0, minTimestamp: 0n, maxTimestamp: 0n },
    eventsSubTreeRoot: new Uint8Array(32),
  },
  fixtureProof: [],
  mainTreeProof: [],
  statHome: { statToProve: { key: 1, value: 0, period: 0 }, eventStatRoot: new Uint8Array(32), statProof: [] },
  statAway: { statToProve: { key: 2, value: 0, period: 0 }, eventStatRoot: new Uint8Array(32), statProof: [] },
});

describe('buildSetComputeUnitLimitInstruction', () => {
  it('encodes the compute budget tag and u32 little-endian units', () => {
    const ix = buildSetComputeUnitLimitInstruction(DEFAULT_COMPUTE_UNIT_LIMIT);
    expect(ix.programAddress).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
    // 1_400_000 = 0x155cc0 -> LE bytes c0 5c 15 00, prefixed by the tag byte 2.
    expect(Array.from(ix.data ?? new Uint8Array())).toEqual([2, 192, 92, 21, 0]);
  });
});

describe('buildInitializeStrategyInstruction', () => {
  it('orders authority, strategy, system and prefixes the discriminator', async () => {
    const [strategy] = await deriveStrategyPda(PROGRAM, AUTHORITY, 0n);
    const built = buildInitializeStrategyInstruction({
      programId: PROGRAM,
      authority: AUTHORITY,
      strategy,
      strategyId: 0n,
      txlineProgram: TXORACLE,
      startingBankroll: 1_000_000_000n,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const accounts = built.value.accounts ?? [];
    expect(accounts).toHaveLength(3);
    expect(accounts[0]?.address).toBe(AUTHORITY);
    expect(accounts[0]?.role).toBe(AccountRole.WRITABLE_SIGNER);
    expect(accounts[1]?.address).toBe(strategy);
    expect(accounts[1]?.role).toBe(AccountRole.WRITABLE);
    expect(accounts[2]?.address).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect(accounts[2]?.role).toBe(AccountRole.READONLY);
    expect(startsWith(built.value.data, INITIALIZE_STRATEGY_DISCRIMINATOR)).toBe(true);
  });
});

describe('buildCommitDecisionInstruction', () => {
  it('orders authority, strategy, decision, system and prefixes the discriminator', async () => {
    const [strategy] = await deriveStrategyPda(PROGRAM, AUTHORITY, 0n);
    const [decision] = await deriveCommitPda(PROGRAM, strategy, 0n);
    const built = buildCommitDecisionInstruction({
      programId: PROGRAM,
      authority: AUTHORITY,
      strategy,
      decision,
      commitHash: new Uint8Array(32).fill(9),
      fixtureId: 17_588_227n,
      market: 0,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const accounts = built.value.accounts ?? [];
    expect(accounts).toHaveLength(4);
    expect(accounts[0]?.role).toBe(AccountRole.WRITABLE_SIGNER);
    expect(accounts[1]?.address).toBe(strategy);
    expect(accounts[2]?.address).toBe(decision);
    expect(accounts[2]?.role).toBe(AccountRole.WRITABLE);
    expect(accounts[3]?.address).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect(startsWith(built.value.data, COMMIT_DECISION_DISCRIMINATOR)).toBe(true);
  });
});

describe('buildSettleDecisionInstruction', () => {
  it('orders authority, strategy, decision, txline, roots and prefixes the discriminator', async () => {
    const [strategy] = await deriveStrategyPda(PROGRAM, AUTHORITY, 0n);
    const [decision] = await deriveCommitPda(PROGRAM, strategy, 0n);
    const built = buildSettleDecisionInstruction({
      programId: PROGRAM,
      authority: AUTHORITY,
      strategy,
      decision,
      txlineProgram: TXORACLE,
      dailyScoresMerkleRoots: ROOTS,
      settleArgs: sampleSettleArgs(),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const accounts = built.value.accounts ?? [];
    expect(accounts).toHaveLength(5);
    expect(accounts[0]?.address).toBe(AUTHORITY);
    expect(accounts[0]?.role).toBe(AccountRole.READONLY_SIGNER);
    expect(accounts[1]?.address).toBe(strategy);
    expect(accounts[1]?.role).toBe(AccountRole.WRITABLE);
    expect(accounts[2]?.address).toBe(decision);
    expect(accounts[3]?.address).toBe(TXORACLE);
    expect(accounts[3]?.role).toBe(AccountRole.READONLY);
    expect(accounts[4]?.address).toBe(ROOTS);
    expect(startsWith(built.value.data, SETTLE_DECISION_DISCRIMINATOR)).toBe(true);
  });
});
