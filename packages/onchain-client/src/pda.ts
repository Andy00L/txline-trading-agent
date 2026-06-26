import { getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/kit';

const addressEncoder = getAddressEncoder();

const textSeed = (text: string): Uint8Array => new TextEncoder().encode(text);

const u64Le = (value: bigint): Uint8Array => {
  const buffer = new Uint8Array(8);
  new DataView(buffer.buffer).setBigUint64(0, value, true);
  return buffer;
};

const u16Le = (value: number): Uint8Array => {
  const buffer = new Uint8Array(2);
  new DataView(buffer.buffer).setUint16(0, value, true);
  return buffer;
};

/** Strategy PDA: ["strategy", authority, strategyId as u64 LE]. */
export const deriveStrategyPda = (programId: Address, authority: Address, strategyId: bigint) =>
  getProgramDerivedAddress({
    programAddress: programId,
    seeds: [textSeed('strategy'), addressEncoder.encode(authority), u64Le(strategyId)],
  });

/** DecisionCommit PDA: ["commit", strategy, index as u64 LE]. */
export const deriveCommitPda = (programId: Address, strategy: Address, index: bigint) =>
  getProgramDerivedAddress({
    programAddress: programId,
    seeds: [textSeed('commit'), addressEncoder.encode(strategy), u64Le(index)],
  });

/**
 * The txoracle daily_scores_roots PDA for the UTC day of ts (milliseconds):
 * ["daily_scores_roots", floor(ts / 86_400_000) as u16 LE], derived against the
 * txoracle program. sourceRef: docs/research/M0-recon-findings.md (O5, PDA seeds).
 */
export const deriveDailyScoresRootsPda = (txoracleProgramId: Address, tsMs: bigint) =>
  getProgramDerivedAddress({
    programAddress: txoracleProgramId,
    seeds: [textSeed('daily_scores_roots'), u16Le(Number(tsMs / 86_400_000n))],
  });
