import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Commitment,
  type Instruction,
  type Rpc,
  type RpcSubscriptions,
  type Signature,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from '@solana/kit';
import { err, ok, redactSecrets, type Result } from '@txline-agent/core';
import {
  decodeDecisionCommitAccount,
  decodeStrategyAccount,
  STATUS_SETTLED,
  type DecisionCommitAccount,
  type StrategyAccount,
} from './account-decode.js';
import {
  buildCommitDecisionInstruction,
  buildInitializeStrategyInstruction,
  buildSetComputeUnitLimitInstruction,
  buildSettleDecisionInstruction,
  DEFAULT_COMPUTE_UNIT_LIMIT,
} from './instruction-build.js';
import { deriveCommitPda, deriveDailyScoresRootsPda, deriveStrategyPda } from './pda.js';
import type {
  CommitReceipt,
  CommitRequest,
  OnChainError,
  OnChainPort,
  SettleReceipt,
  SettleRequest,
} from './port.js';

// The base (non-cluster-branded) rpc types createSolanaRpc(url: string) returns, which the
// sendAndConfirmTransactionFactory generic overload accepts (SolanaRpcApi includes the
// GetEpochInfo, GetSignatureStatuses, and SendTransaction APIs it needs).
type SolanaRpc = Rpc<SolanaRpcApi>;
type SolanaRpcSubscriptions = RpcSubscriptions<SolanaRpcSubscriptionsApi>;

export type SolanaOnChainPortConfig = {
  readonly rpc: SolanaRpc;
  readonly rpcSubscriptions: SolanaRpcSubscriptions;
  readonly authority: TransactionSigner;
  readonly programId: Address;
  readonly txoracleProgramId: Address;
  readonly strategyId: bigint;
  readonly computeUnitLimit?: number;
  readonly commitment?: Commitment;
};

// Redact any secret (a keyed RPC endpoint URL, an api-key token) from a transport error before
// it becomes an error value the agent records and serves publicly. sourceRef: redactSecrets (core).
const messageOf = (cause: unknown): string =>
  redactSecrets(cause instanceof Error ? cause.message : String(cause));

/**
 * The live OnChainPort: builds, signs, and confirms agent_ledger transactions with
 * @solana/kit against a configured RPC. The authority signer is the fee payer for every
 * transaction. Every method returns a Result; the only try/catch is the RPC boundary,
 * where a throwing transport is adapted into an error value. settle prepends a compute
 * budget instruction because the validate_stat CPI is heavy.
 */
export class SolanaOnChainPort implements OnChainPort {
  private readonly rpc: SolanaRpc;
  private readonly authority: TransactionSigner;
  private readonly programId: Address;
  private readonly txoracleProgramId: Address;
  private readonly strategyId: bigint;
  private readonly computeUnitLimit: number;
  private readonly commitment: Commitment;
  private readonly sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
  private strategyAddressCache: Address | null = null;

  constructor(config: SolanaOnChainPortConfig) {
    this.rpc = config.rpc;
    this.authority = config.authority;
    this.programId = config.programId;
    this.txoracleProgramId = config.txoracleProgramId;
    this.strategyId = config.strategyId;
    this.computeUnitLimit = config.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
    this.commitment = config.commitment ?? 'confirmed';
    this.sendAndConfirm = sendAndConfirmTransactionFactory({
      rpc: config.rpc,
      rpcSubscriptions: config.rpcSubscriptions,
    });
  }

  /** The strategy PDA for this authority and strategy id, derived once and cached. */
  async strategyAddress(): Promise<Address> {
    if (this.strategyAddressCache) {
      return this.strategyAddressCache;
    }
    const [pda] = await deriveStrategyPda(this.programId, this.authority.address, this.strategyId);
    this.strategyAddressCache = pda;
    return pda;
  }

  private async sendInstructions(
    instructions: readonly Instruction[],
  ): Promise<Result<Signature, OnChainError>> {
    try {
      const { value: latestBlockhash } = await this.rpc.getLatestBlockhash().send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (draft) => setTransactionMessageFeePayerSigner(this.authority, draft),
        (draft) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, draft),
        (draft) => appendTransactionMessageInstructions(instructions, draft),
      );
      const signedTransaction = await signTransactionMessageWithSigners(message);
      await this.sendAndConfirm(signedTransaction, { commitment: this.commitment });
      return ok(getSignatureFromTransaction(signedTransaction));
    } catch (sendError) {
      return err({ kind: 'rpc', detail: messageOf(sendError) });
    }
  }

  private async fetchAccountBytes(account: Address): Promise<Result<Uint8Array | null, OnChainError>> {
    try {
      const response = await this.rpc.getAccountInfo(account, { encoding: 'base64' }).send();
      if (!response.value) {
        return ok(null);
      }
      return ok(Uint8Array.from(getBase64Encoder().encode(response.value.data[0])));
    } catch (fetchError) {
      return err({ kind: 'rpc', detail: messageOf(fetchError) });
    }
  }

  /** Read the Strategy account, or null if it has not been initialized yet. */
  async readStrategy(): Promise<Result<StrategyAccount | null, OnChainError>> {
    const strategy = await this.strategyAddress();
    const bytes = await this.fetchAccountBytes(strategy);
    if (!bytes.ok) {
      return bytes;
    }
    if (bytes.value === null) {
      return ok(null);
    }
    const decoded = decodeStrategyAccount(bytes.value);
    if (!decoded.ok) {
      return err({ kind: 'account-decode', detail: `${decoded.error.kind}: ${decoded.error.detail}` });
    }
    return ok(decoded.value);
  }

  /** Read a DecisionCommit account by index, or null if it does not exist. */
  async readDecision(index: bigint): Promise<Result<DecisionCommitAccount | null, OnChainError>> {
    const strategy = await this.strategyAddress();
    const [decision] = await deriveCommitPda(this.programId, strategy, index);
    const bytes = await this.fetchAccountBytes(decision);
    if (!bytes.ok) {
      return bytes;
    }
    if (bytes.value === null) {
      return ok(null);
    }
    const decoded = decodeDecisionCommitAccount(bytes.value);
    if (!decoded.ok) {
      return err({ kind: 'account-decode', detail: `${decoded.error.kind}: ${decoded.error.detail}` });
    }
    return ok(decoded.value);
  }

  /** Create the strategy ledger, pinning the txoracle program as the CPI target. */
  async initializeStrategy(
    startingBankroll: bigint,
  ): Promise<Result<{ readonly txSig: string; readonly strategy: Address }, OnChainError>> {
    const strategy = await this.strategyAddress();
    const instruction = buildInitializeStrategyInstruction({
      programId: this.programId,
      authority: this.authority.address,
      strategy,
      strategyId: this.strategyId,
      txlineProgram: this.txoracleProgramId,
      startingBankroll,
    });
    if (!instruction.ok) {
      return err({ kind: 'encode', detail: `${instruction.error.field}: ${instruction.error.detail}` });
    }
    const sent = await this.sendInstructions([instruction.value]);
    if (!sent.ok) {
      return sent;
    }
    return ok({ txSig: sent.value, strategy });
  }

  async commit(request: CommitRequest): Promise<Result<CommitReceipt, OnChainError>> {
    const strategyResult = await this.readStrategy();
    if (!strategyResult.ok) {
      return strategyResult;
    }
    if (strategyResult.value === null) {
      return err({
        kind: 'not-initialized',
        detail: 'strategy account does not exist; call initializeStrategy first',
      });
    }
    const index = strategyResult.value.decisionsCount;
    if (request.reveal.index !== index) {
      return err({
        kind: 'index-mismatch',
        detail: `reveal.index ${request.reveal.index} does not match on-chain decisions_count ${index}; rebuild the reveal and commit hash at the current index`,
      });
    }
    const strategy = await this.strategyAddress();
    const [decision] = await deriveCommitPda(this.programId, strategy, index);
    const instruction = buildCommitDecisionInstruction({
      programId: this.programId,
      authority: this.authority.address,
      strategy,
      decision,
      commitHash: request.commitHash,
      fixtureId: request.fixtureId,
      market: request.market,
    });
    if (!instruction.ok) {
      return err({ kind: 'encode', detail: `${instruction.error.field}: ${instruction.error.detail}` });
    }
    const sent = await this.sendInstructions([instruction.value]);
    if (!sent.ok) {
      return sent;
    }
    return ok({ positionId: decision, txSig: sent.value, index });
  }

  async settle(request: SettleRequest): Promise<Result<SettleReceipt, OnChainError>> {
    const strategy = await this.strategyAddress();
    const [decision] = await deriveCommitPda(this.programId, strategy, request.index);
    const [dailyScoresMerkleRoots] = await deriveDailyScoresRootsPda(
      this.txoracleProgramId,
      request.settleArgs.ts,
    );
    const settleInstruction = buildSettleDecisionInstruction({
      programId: this.programId,
      authority: this.authority.address,
      strategy,
      decision,
      txlineProgram: this.txoracleProgramId,
      dailyScoresMerkleRoots,
      settleArgs: request.settleArgs,
    });
    if (!settleInstruction.ok) {
      return err({ kind: 'encode', detail: `${settleInstruction.error.field}: ${settleInstruction.error.detail}` });
    }
    const computeBudget = buildSetComputeUnitLimitInstruction(this.computeUnitLimit);
    const sent = await this.sendInstructions([computeBudget, settleInstruction.value]);
    if (!sent.ok) {
      return sent;
    }

    // Read the settled decision back so won/pnl come from the on-chain accounting, not a
    // local recomputation. outcome_side is set to the claimed result, and the program only
    // writes it when the validate_stat CPI proved that result, so this is authoritative.
    const decoded = await this.readDecision(request.index);
    if (!decoded.ok) {
      return decoded;
    }
    if (decoded.value === null) {
      return err({ kind: 'account-missing', detail: 'decision account not found after settle' });
    }
    const won =
      decoded.value.status === STATUS_SETTLED &&
      decoded.value.outcomeSide === request.settleArgs.reveal.side;
    return ok({ txSig: sent.value, won, pnl: decoded.value.pnl });
  }
}
