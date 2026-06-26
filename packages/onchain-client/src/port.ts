import type { Result } from '@txline-agent/core';
import type { RevealArgs } from './borsh.js';
import type { SettleArgsInput } from './settle-encode.js';

export type CommitReceipt = {
  readonly positionId: string;
  readonly txSig: string;
  readonly index: bigint;
};
export type SettleReceipt = { readonly txSig: string; readonly won: boolean; readonly pnl: bigint };
export type OnChainError = { readonly kind: string; readonly detail: string };

export type CommitRequest = {
  readonly commitHash: Uint8Array;
  readonly fixtureId: bigint;
  readonly market: number;
  readonly reveal: RevealArgs;
};
export type SettleRequest = { readonly index: bigint; readonly settleArgs: SettleArgsInput };

/**
 * The two-method boundary the agent and backtest swap: a live @solana/kit client in
 * production, a recording mock in the backtest. Both commit and settle return a
 * Result so the pipeline never throws. sourceRef: docs/BUILD_PLAN.md (OnChainPort).
 */
export interface OnChainPort {
  commit(request: CommitRequest): Promise<Result<CommitReceipt, OnChainError>>;
  settle(request: SettleRequest): Promise<Result<SettleReceipt, OnChainError>>;
}
