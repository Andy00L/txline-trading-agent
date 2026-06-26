import {
  closingLineValueProb,
  type CommittedPosition,
  type PipelineSink,
  type Result,
  type SettledPosition,
} from '@txline-agent/core';
import {
  buildSettleArgs,
  computeCommitHash,
  type CommitReceipt,
  type CommitRequest,
  type OnChainError,
  type RevealArgs,
  type SettleReceipt,
  type SettleRequest,
  type StrategyAccount,
} from '@txline-agent/onchain-client';
import type { ScoresStatValidation, TxlineError } from '@txline-agent/txline';
import { buildRevealFromDecision, SIDE_AWAY, SIDE_DRAW, SIDE_HOME } from './reveal.js';
import type { AgentStateStore } from './state-store.js';

/**
 * The live PipelineSink: it turns each pipeline lifecycle event into an agent_ledger
 * transaction. On a commit it reads the on-chain decisions_count, seals the decision into a
 * RevealArgs at that index, hashes it, and commits; it remembers the reveal so settle can
 * reuse it. On a settlement it fetches the stat-validation proof for the exact settled seq,
 * derives the claimed result from the proven goals, and settles by CPI into validate_stat.
 * Every external call returns a Result, so the sink never throws out of runPipeline; failures
 * are recorded in the store and logged. The backtest swaps this for a RecordingSink, so the
 * decision code is identical and only this adapter is live.
 *
 * sourceRef: tools/devnet/src/settle-e2e.ts (the proven commit/settle path), docs/BUILD_PLAN.md
 * (OnChainPort, one code path for live and replay).
 */

/** The subset of the on-chain port the sink drives. SolanaOnChainPort satisfies it; a test
 * provides a fake, so the sink is unit-testable without an RPC. */
export interface CommitSettlePort {
  readStrategy(): Promise<Result<StrategyAccount | null, OnChainError>>;
  commit(request: CommitRequest): Promise<Result<CommitReceipt, OnChainError>>;
  settle(request: SettleRequest): Promise<Result<SettleReceipt, OnChainError>>;
}

/** The subset of TxlineClient the sink needs (the score proof for a settle). */
export interface ScoresProofSource {
  getScoresStatValidation(params: {
    readonly fixtureId: number;
    readonly seq: number;
    readonly statKey: number;
    readonly statKey2?: number;
  }): Promise<Result<ScoresStatValidation, TxlineError>>;
}

// Full-game goal stat keys (period 0): base 1 = participant 1 goals, 2 = participant 2 goals.
// sourceRef: docs/research/M0-recon-findings.md A-3.
const STAT_KEY_PARTICIPANT1 = 1;
const STAT_KEY_PARTICIPANT2 = 2;

const explorerTxUrl = (signature: string): string =>
  `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

export type OnChainSinkDeps = {
  readonly port: CommitSettlePort;
  readonly proofs: ScoresProofSource;
  readonly store: AgentStateStore;
  readonly strategyBytes: Uint8Array; // 32-byte strategy PDA, precomputed by the runtime
  readonly nextNonce: () => Uint8Array; // a fresh 32-byte sealing nonce per commit (injected)
  readonly log?: (message: string) => void;
};

type CommittedReveal = { readonly reveal: RevealArgs; readonly onChainIndex: bigint };

export class OnChainSink implements PipelineSink {
  private readonly port: CommitSettlePort;
  private readonly proofs: ScoresProofSource;
  private readonly store: AgentStateStore;
  private readonly strategyBytes: Uint8Array;
  private readonly nextNonce: () => Uint8Array;
  private readonly logLine: (message: string) => void;
  // Maps the pipeline-local index to the sealed reveal and the on-chain index, so settle can
  // rebuild the exact settle args and target the right DecisionCommit account.
  private readonly committed = new Map<number, CommittedReveal>();

  constructor(deps: OnChainSinkDeps) {
    this.port = deps.port;
    this.proofs = deps.proofs;
    this.store = deps.store;
    this.strategyBytes = deps.strategyBytes;
    this.nextNonce = deps.nextNonce;
    this.logLine = deps.log ?? ((message: string) => console.log(message));
  }

  async onCommit(position: CommittedPosition): Promise<void> {
    const strategy = await this.port.readStrategy();
    if (!strategy.ok) {
      this.fail('commit', position.index, `readStrategy ${strategy.error.kind}: ${strategy.error.detail}`);
      return;
    }
    if (strategy.value === null) {
      this.fail('commit', position.index, 'strategy account is not initialized');
      return;
    }
    const onChainIndex = strategy.value.decisionsCount;
    const reveal = buildRevealFromDecision({
      decision: position.decision,
      strategyBytes: this.strategyBytes,
      index: onChainIndex,
      nonce: this.nextNonce(),
    });
    if (!reveal.ok) {
      this.fail('commit', position.index, `reveal ${reveal.error.kind}: ${reveal.error.detail}`);
      return;
    }
    const commitHash = computeCommitHash(reveal.value);
    if (!commitHash.ok) {
      this.fail('commit', position.index, `commit-hash ${commitHash.error.field}: ${commitHash.error.detail}`);
      return;
    }
    const receipt = await this.port.commit({
      commitHash: commitHash.value,
      fixtureId: reveal.value.fixtureId,
      market: reveal.value.market,
      reveal: reveal.value,
    });
    if (!receipt.ok) {
      this.fail('commit', position.index, `commit ${receipt.error.kind}: ${receipt.error.detail}`);
      return;
    }
    this.committed.set(position.index, { reveal: reveal.value, onChainIndex: receipt.value.index });
    this.store.recordCommit({
      index: position.index,
      onChainIndex: receipt.value.index.toString(),
      fixtureId: position.decision.fixtureId,
      marketKey: position.decision.marketKey,
      outcome: position.decision.outcome,
      signalKind: position.decision.signalKind,
      stakeMicroUsd: position.decision.stake.toString(),
      entryOddsMilli: position.decision.entryOddsMilli,
      fairProb: position.decision.fairProb,
      committedAtMs: position.committedAtMs,
      txSig: receipt.value.txSig,
      explorerUrl: explorerTxUrl(receipt.value.txSig),
    });
    this.logLine(
      `[OnChainSink] committed #${position.index} fixture ${position.decision.fixtureId} ${position.decision.outcome} ${explorerTxUrl(receipt.value.txSig)}`,
    );
  }

  async onSettle(position: SettledPosition): Promise<void> {
    const pending = this.committed.get(position.index);
    if (pending === undefined) {
      this.fail('settle', position.index, 'no committed reveal (its commit failed earlier)');
      return;
    }
    const proof = await this.proofs.getScoresStatValidation({
      fixtureId: position.decision.fixtureId,
      seq: position.settledSeq,
      statKey: STAT_KEY_PARTICIPANT1,
      statKey2: STAT_KEY_PARTICIPANT2,
    });
    if (!proof.ok) {
      this.fail('settle', position.index, `stat-validation ${proof.error.kind}: ${proof.error.detail}`);
      return;
    }
    const validation = proof.value;
    if (validation.statToProve2 === undefined) {
      this.fail('settle', position.index, 'stat-validation returned no participant-2 stat (statKey2)');
      return;
    }
    // claimedResult is in participant space (statToProve = participant 1, statToProve2 =
    // participant 2), which is what the on-chain predicate is derived over. The program
    // proves it against the oracle root, so a passing settle means the real result matched.
    const participant1Goals = validation.statToProve.value;
    const participant2Goals = validation.statToProve2.value;
    const claimedResult =
      participant1Goals > participant2Goals
        ? SIDE_HOME
        : participant1Goals === participant2Goals
          ? SIDE_DRAW
          : SIDE_AWAY;
    const settleArgs = buildSettleArgs({ validation, reveal: pending.reveal, claimedResult });
    if (!settleArgs.ok) {
      this.fail('settle', position.index, `settle-args ${settleArgs.error.field}: ${settleArgs.error.detail}`);
      return;
    }
    const receipt = await this.port.settle({ index: pending.onChainIndex, settleArgs: settleArgs.value });
    if (!receipt.ok) {
      this.fail('settle', position.index, `settle ${receipt.error.kind}: ${receipt.error.detail}`);
      return;
    }
    const clvProb = closingLineValueProb(position.decision.fairProb, position.closingFairProb);
    this.store.markSettled(position.index, {
      index: position.index,
      fixtureId: position.decision.fixtureId,
      outcome: position.decision.outcome,
      result: position.result,
      won: receipt.value.won,
      pnlMicroUsd: receipt.value.pnl.toString(),
      settledSeq: position.settledSeq,
      settledAtMs: position.settledAtMs,
      closingFairProb: position.closingFairProb,
      clvProb,
      txSig: receipt.value.txSig,
      explorerUrl: explorerTxUrl(receipt.value.txSig),
    });
    this.logLine(
      `[OnChainSink] settled #${position.index} won=${receipt.value.won} pnl=${receipt.value.pnl} ${explorerTxUrl(receipt.value.txSig)}`,
    );
  }

  private fail(stage: string, index: number, detail: string): void {
    this.store.recordError(stage, `#${index}: ${detail}`);
    this.logLine(`[OnChainSink] ${stage} failed #${index}: ${detail}`);
  }
}
