/**
 * Typed client for the read-only agent API (the @txline-agent/api server). The dashboard
 * consumes it over HTTP/SSE only and keeps its own copy of the response shape, so it stays
 * decoupled from the runtime packages (sourceRef: docs/BUILD_PLAN.md, "dashboard -> api
 * (HTTP only)"). These types mirror packages/agent/src/state-store.ts (AgentSnapshot); all
 * money fields are decimal strings of micro-USD.
 */

export type FeedStatusView = { readonly kind: string; readonly detail: string; readonly atMs: number };

export type PositionStatus = 'committed' | 'settled';

export type CommitView = {
  readonly index: number;
  readonly onChainIndex: string;
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
  // The third trust link: set once prove_entry_odds proves the sealed entry price on-chain.
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

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080';

const parseSnapshot = (data: string): AgentSnapshot | null => {
  try {
    // The API is our own trusted service; a parse failure is the only expected error.
    const snapshot: AgentSnapshot = JSON.parse(data);
    return snapshot;
  } catch {
    return null;
  }
};

/**
 * Subscribe to the agent's live state. The SSE endpoint pushes the current snapshot on
 * connect and one on every change. Returns an unsubscribe function that closes the stream.
 */
export type ConnectionListener = (connected: boolean) => void;

export const subscribeToEvents = (
  onSnapshot: (snapshot: AgentSnapshot) => void,
  onConnectionChange?: ConnectionListener,
): (() => void) => {
  const source = new EventSource(`${API_BASE}/api/events`);
  source.onopen = () => onConnectionChange?.(true);
  source.onmessage = (event) => {
    const snapshot = parseSnapshot(event.data);
    if (snapshot) {
      onSnapshot(snapshot);
    }
  };
  // EventSource auto-reconnects on a transient drop; onerror fires on the drop and on each failed
  // retry. Surface it so the UI shows a reconnecting state instead of stale data presented as live.
  source.onerror = () => onConnectionChange?.(false);
  return () => source.close();
};
