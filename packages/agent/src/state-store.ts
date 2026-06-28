import { redactSecrets, type Clock } from '@txline-agent/core';

/**
 * In-memory projection of the agent's run, the single source of truth the read-only API
 * serves. The on-chain sink records commits and settlements here; the feed tap records the
 * event count and connection status. Bigints are exposed as decimal strings so the snapshot
 * is plain JSON. The clock is injected (core Clock) so tests are deterministic.
 *
 * Restart semantics: this projection and the on-chain sink's pending-reveal map are in-memory
 * only. The Solana ledger is the durable source of truth; a restart loses the projection and
 * any pre-settle reveals, so a decision committed before a restart whose match ends after it
 * cannot be settled by the new process. Do not restart the agent mid-match. sourceRef:
 * docs/runbooks/M6-agent.md.
 */

export type FeedStatusView = { readonly kind: string; readonly detail: string; readonly atMs: number };

export type PositionStatus = 'committed' | 'settled';

export type CommitView = {
  readonly index: number; // pipeline-local index (matches a settlement)
  readonly onChainIndex: string; // the on-chain decisions_count used for this commit
  readonly commitHash: string; // keccak256(borsh(reveal)) sealed on-chain, lowercase hex (64 chars)
  readonly fixtureId: number;
  readonly marketKey: string;
  readonly outcome: string;
  readonly signalKind: string;
  readonly stakeMicroUsd: string;
  readonly entryOddsMilli: number;
  readonly fairProb: number;
  readonly committedAtMs: number;
  readonly txSig: string;
  readonly explorerUrl: string;
};

export type SettleView = {
  readonly index: number;
  readonly fixtureId: number;
  readonly outcome: string;
  readonly result: string;
  readonly won: boolean;
  readonly pnlMicroUsd: string;
  readonly settledSeq: number;
  readonly settledAtMs: number;
  readonly closingFairProb: number;
  readonly clvProb: number;
  readonly txSig: string;
  readonly explorerUrl: string;
  // The third trust link: set when prove_entry_odds proves the sealed entry price on-chain after
  // settle. entryOddsProven stays false until then; the odds-proof tx links to the validate_odds CPI.
  readonly entryOddsProven: boolean;
  readonly oddsProofTxSig: string | null;
  readonly oddsProofExplorerUrl: string | null;
};

export type AgentErrorView = { readonly stage: string; readonly detail: string; readonly atMs: number };

export type PositionView = CommitView & {
  readonly status: PositionStatus;
  readonly settlement: SettleView | null;
};

export type AgentSnapshot = {
  readonly startedAtMs: number;
  readonly eventsProcessed: number;
  readonly commitsCount: number;
  readonly settlesCount: number;
  readonly errorsCount: number;
  readonly lastEventAtMs: number | null;
  readonly feedStatus: FeedStatusView | null;
  readonly startingBankrollMicroUsd: string;
  readonly realizedPnlMicroUsd: string;
  readonly bankrollMicroUsd: string;
  readonly positions: readonly PositionView[];
  readonly recentErrors: readonly AgentErrorView[];
};

// Keep the error log bounded so a long run cannot grow memory without limit.
const MAX_RECENT_ERRORS = 50;

type PositionEntry = {
  readonly commit: CommitView;
  status: PositionStatus;
  settlement: SettleView | null;
};

export type AgentStateStoreDeps = {
  readonly clock: Clock;
  readonly startingBankroll: bigint;
};

export class AgentStateStore {
  private readonly clock: Clock;
  private readonly startingBankroll: bigint;
  private readonly startedAtMs: number;
  private eventsProcessed = 0;
  private settlesCount = 0;
  private errorsCount = 0;
  private lastEventAtMs: number | null = null;
  private feedStatus: FeedStatusView | null = null;
  private realizedPnl = 0n;
  private readonly positions = new Map<number, PositionEntry>();
  private readonly recentErrors: AgentErrorView[] = [];
  private readonly listeners = new Set<(snapshot: AgentSnapshot) => void>();

  constructor(deps: AgentStateStoreDeps) {
    this.clock = deps.clock;
    this.startingBankroll = deps.startingBankroll;
    this.startedAtMs = deps.clock.nowMs();
  }

  recordEvent(): void {
    this.eventsProcessed += 1;
    this.lastEventAtMs = this.clock.nowMs();
    this.emit();
  }

  recordFeedStatus(kind: string, detail: string): void {
    this.feedStatus = { kind, detail, atMs: this.clock.nowMs() };
    this.emit();
  }

  recordCommit(commit: CommitView): void {
    this.positions.set(commit.index, { commit, status: 'committed', settlement: null });
    this.emit();
  }

  markSettled(index: number, settlement: SettleView): void {
    const entry = this.positions.get(index);
    if (entry === undefined) {
      // A settle for an unknown index would corrupt the bankroll and settle count with no
      // position behind it. Record it as an error instead of counting phantom PnL.
      this.recordError('settle', `#${index}: settlement for an unknown position index`);
      return;
    }
    entry.status = 'settled';
    entry.settlement = settlement;
    this.settlesCount += 1;
    this.realizedPnl += BigInt(settlement.pnlMicroUsd);
    this.emit();
  }

  /** Record the on-chain entry-odds proof (third trust link) on a settled position. Records an
   * error if the position is unknown or not yet settled, so a stray proof cannot corrupt state. */
  markOddsProven(index: number, proof: { readonly txSig: string; readonly explorerUrl: string }): void {
    const entry = this.positions.get(index);
    if (entry === undefined || entry.settlement === null) {
      this.recordError('prove-odds', `#${index}: entry-odds proof for an unknown or unsettled position`);
      return;
    }
    entry.settlement = {
      ...entry.settlement,
      entryOddsProven: true,
      oddsProofTxSig: proof.txSig,
      oddsProofExplorerUrl: proof.explorerUrl,
    };
    this.emit();
  }

  recordError(stage: string, detail: string): void {
    this.errorsCount += 1;
    // Defense in depth: redact any secret (a keyed RPC URL, an api-key token) before it lands
    // in recentErrors, which the read-only API serves publicly. sourceRef: redactSecrets (core).
    this.recentErrors.push({ stage, detail: redactSecrets(detail), atMs: this.clock.nowMs() });
    while (this.recentErrors.length > MAX_RECENT_ERRORS) {
      this.recentErrors.shift();
    }
    this.emit();
  }

  /** Subscribe to snapshots pushed on every state change (the API's SSE endpoint). Returns
   * an unsubscribe function. */
  subscribe(listener: (snapshot: AgentSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): AgentSnapshot {
    const positions = [...this.positions.values()]
      .map((entry) => ({ ...entry.commit, status: entry.status, settlement: entry.settlement }))
      .sort((left, right) => left.index - right.index);
    const bankroll = this.startingBankroll + this.realizedPnl;
    return {
      startedAtMs: this.startedAtMs,
      eventsProcessed: this.eventsProcessed,
      commitsCount: this.positions.size,
      settlesCount: this.settlesCount,
      errorsCount: this.errorsCount,
      lastEventAtMs: this.lastEventAtMs,
      feedStatus: this.feedStatus,
      startingBankrollMicroUsd: this.startingBankroll.toString(),
      realizedPnlMicroUsd: this.realizedPnl.toString(),
      bankrollMicroUsd: bankroll.toString(),
      positions,
      recentErrors: [...this.recentErrors],
    };
  }

  private emit(): void {
    if (this.listeners.size === 0) {
      return;
    }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A subscriber error (e.g. a disconnected SSE client whose write throws) must never
        // abort the pipeline step that recorded this update. Drop the failing listener.
        this.listeners.delete(listener);
      }
    }
  }
}
