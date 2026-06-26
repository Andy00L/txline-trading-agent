import {
  AccountRole,
  address,
  getAddressEncoder,
  type AccountMeta,
  type Address,
  type Instruction,
} from '@solana/kit';
import { ok, type Result } from '@txline-agent/core';
import type { EncodeError } from './borsh.js';
import {
  encodeCommitDecisionData,
  encodeInitializeStrategyData,
  encodeSettleDecisionData,
} from './instruction-data.js';
import type { SettleArgsInput } from './settle-encode.js';

const addressEncoder = getAddressEncoder();

// The System program, invoked by Anchor `init` to create the PDA accounts.
// sourceRef: Solana system program id (32 zero bytes, base58).
export const SYSTEM_PROGRAM_ADDRESS = address('11111111111111111111111111111111');

// The Compute Budget program. sourceRef: ~/.txline-recon/ex-onchain-validation.md.
export const COMPUTE_BUDGET_PROGRAM_ADDRESS = address(
  'ComputeBudget111111111111111111111111111111',
);

// Max compute units per transaction. validate_stat under CPI is heavy; the official
// validation example sets exactly this, while the older repo examples request
// 10_000_000, which the runtime caps to the same ceiling. Configurable per call.
// sourceRef: ~/.txline-recon/ex-onchain-validation.md (units: 1_400_000).
export const DEFAULT_COMPUTE_UNIT_LIMIT = 1_400_000;

// SetComputeUnitLimit is index 2 of the Compute Budget program: a 1-byte tag then the
// u32 LE unit limit. sourceRef: Solana ComputeBudgetInstruction (SetComputeUnitLimit).
const SET_COMPUTE_UNIT_LIMIT_TAG = 2;

const metaReadonly = (account: Address): AccountMeta => ({ address: account, role: AccountRole.READONLY });
const metaWritable = (account: Address): AccountMeta => ({ address: account, role: AccountRole.WRITABLE });
const metaWritableSigner = (account: Address): AccountMeta => ({
  address: account,
  role: AccountRole.WRITABLE_SIGNER,
});
const metaReadonlySigner = (account: Address): AccountMeta => ({
  address: account,
  role: AccountRole.READONLY_SIGNER,
});

const encodeAddressBytes = (account: Address): Uint8Array =>
  Uint8Array.from(addressEncoder.encode(account));

/** A SetComputeUnitLimit instruction; prepend it so the heavy settle CPI gets enough units. */
export const buildSetComputeUnitLimitInstruction = (units: number): Instruction => {
  const data = new Uint8Array(5);
  data[0] = SET_COMPUTE_UNIT_LIMIT_TAG;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data };
};

/**
 * initialize_strategy. Accounts mirror the Anchor InitializeStrategy context order:
 * authority (signer, payer), strategy (init PDA), system_program.
 */
export const buildInitializeStrategyInstruction = (input: {
  readonly programId: Address;
  readonly authority: Address;
  readonly strategy: Address;
  readonly strategyId: bigint;
  readonly txlineProgram: Address;
  readonly startingBankroll: bigint;
}): Result<Instruction, EncodeError> => {
  const data = encodeInitializeStrategyData({
    strategyId: input.strategyId,
    txlineProgram: encodeAddressBytes(input.txlineProgram),
    startingBankroll: input.startingBankroll,
  });
  if (!data.ok) {
    return data;
  }
  return ok({
    programAddress: input.programId,
    accounts: [
      metaWritableSigner(input.authority),
      metaWritable(input.strategy),
      metaReadonly(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: data.value,
  });
};

/**
 * commit_decision. Accounts mirror the Anchor CommitDecision context order:
 * authority (signer, payer), strategy, decision (init PDA), system_program.
 */
export const buildCommitDecisionInstruction = (input: {
  readonly programId: Address;
  readonly authority: Address;
  readonly strategy: Address;
  readonly decision: Address;
  readonly commitHash: Uint8Array;
  readonly fixtureId: bigint;
  readonly market: number;
}): Result<Instruction, EncodeError> => {
  const data = encodeCommitDecisionData({
    commitHash: input.commitHash,
    fixtureId: input.fixtureId,
    market: input.market,
  });
  if (!data.ok) {
    return data;
  }
  return ok({
    programAddress: input.programId,
    accounts: [
      metaWritableSigner(input.authority),
      metaWritable(input.strategy),
      metaWritable(input.decision),
      metaReadonly(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: data.value,
  });
};

/**
 * settle_decision. Accounts mirror the Anchor SettleDecision context order:
 * authority (signer), strategy, decision, txline_program (CPI target, read-only),
 * daily_scores_merkle_roots (read-only, read by the validate_stat CPI). The authority
 * is not writable here (no init), so it is a read-only signer at the instruction level;
 * it still pays fees as the transaction fee payer.
 */
export const buildSettleDecisionInstruction = (input: {
  readonly programId: Address;
  readonly authority: Address;
  readonly strategy: Address;
  readonly decision: Address;
  readonly txlineProgram: Address;
  readonly dailyScoresMerkleRoots: Address;
  readonly settleArgs: SettleArgsInput;
}): Result<Instruction, EncodeError> => {
  const data = encodeSettleDecisionData(input.settleArgs);
  if (!data.ok) {
    return data;
  }
  return ok({
    programAddress: input.programId,
    accounts: [
      metaReadonlySigner(input.authority),
      metaWritable(input.strategy),
      metaWritable(input.decision),
      metaReadonly(input.txlineProgram),
      metaReadonly(input.dailyScoresMerkleRoots),
    ],
    data: data.value,
  });
};
