import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { deriveCommitPda, deriveDailyScoresRootsPda, deriveStrategyPda } from './pda.js';

const PROGRAM = address('FLZiKMUaPAGMtPLbfHvHwfiVfkTZD8RZ84CSrkDy1kLD');
const AUTHORITY = address('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
const TXORACLE = address('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');

describe('PDA derivation', () => {
  it('derives a deterministic strategy PDA that varies with strategyId', async () => {
    const [first] = await deriveStrategyPda(PROGRAM, AUTHORITY, 0n);
    const [again] = await deriveStrategyPda(PROGRAM, AUTHORITY, 0n);
    const [other] = await deriveStrategyPda(PROGRAM, AUTHORITY, 1n);
    expect(first).toBe(again);
    expect(other).not.toBe(first);
  });

  it('derives a commit PDA that varies with index', async () => {
    const [strategy] = await deriveStrategyPda(PROGRAM, AUTHORITY, 0n);
    const [zero] = await deriveCommitPda(PROGRAM, strategy, 0n);
    const [one] = await deriveCommitPda(PROGRAM, strategy, 1n);
    expect(zero).not.toBe(one);
  });

  it('derives the daily scores roots PDA per UTC day', async () => {
    const [first] = await deriveDailyScoresRootsPda(TXORACLE, 1_750_000_000_000n);
    const [again] = await deriveDailyScoresRootsPda(TXORACLE, 1_750_000_000_000n);
    const [nextDay] = await deriveDailyScoresRootsPda(TXORACLE, 1_750_000_000_000n + 86_400_000n);
    expect(first).toBe(again);
    expect(nextDay).not.toBe(first);
  });
});
