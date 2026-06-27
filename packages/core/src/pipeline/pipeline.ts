import { buildDecision, type DecisionConfig } from '../decision/build.js';
import type { Decision } from '../domain/decision.js';
import type { DevigMethod } from '../domain/fairbook.js';
import { fairProbOf } from '../domain/fairbook.js';
import type { OddsUpdate, ScoreUpdate } from '../domain/events.js';
import { OUTCOMES_1X2, type MarketKey, type Outcome } from '../domain/market.js';
import { isFinalGameState } from '../domain/score-state.js';
import type { Feed, FeedEnvelope } from '../feed.js';
import { computeFairBook } from '../quant/devig.js';
import { createRiskState, onCommit, onSettlement } from '../risk/manager.js';
import { computePnl } from '../risk/pnl.js';
import type { RiskState } from '../risk/types.js';
import {
  detectDivergence,
  detectSteam,
  type DivergenceConfig,
  type ProbObservation,
  type SteamConfig,
} from '../signal/detect.js';
import type { DecimalOddsMilli, MicroUsd, Prob } from '../units.js';
import type { CommittedPosition, PipelineSink, SettledPosition } from './sink.js';

export type PipelineConfig = {
  readonly devigMethod: DevigMethod;
  readonly steam: SteamConfig;
  readonly divergence: DivergenceConfig;
  readonly decision: DecisionConfig;
  readonly startingBankroll: MicroUsd;
  /** Cap on the per-outcome fair-probability history kept for steam detection. */
  readonly steamHistoryLimit: number;
};

export type PipelineResult = {
  readonly committed: number;
  readonly settled: number;
  readonly finalBankroll: MicroUsd;
  readonly eventsProcessed: number;
};

type MarketState = {
  readonly fixtureId: number;
  readonly history: Map<Outcome, ProbObservation[]>;
  readonly lastFairProb: Map<Outcome, Prob>;
  readonly lastOdds: Map<Outcome, DecimalOddsMilli>;
};

type ScoreState = {
  readonly homeGoals: number;
  readonly awayGoals: number;
  readonly tsMs: number;
  readonly seq: number;
  /** The game-state string this score carried (e.g. 'H2', 'F'); drives the final-whistle
   * settlement trigger and the final-is-sticky precedence in handleScore. */
  readonly gameState: string;
};

type OpenPosition = { readonly index: number; readonly decision: Decision; readonly committedAtMs: number };

type PipelineState = {
  riskState: RiskState;
  readonly markets: Map<MarketKey, MarketState>;
  readonly scores: Map<number, ScoreState>;
  readonly open: OpenPosition[];
  readonly actedMarkets: Set<MarketKey>;
  /** Indices already settled, so the final-whistle path and the end-of-feed sweep never
   * settle the same position twice. */
  readonly settled: Set<number>;
  decisionsCount: number;
};

const resultOf = (homeGoals: number, awayGoals: number): Outcome =>
  homeGoals > awayGoals ? 'home' : homeGoals === awayGoals ? 'draw' : 'away';

const getOrCreateMarket = (
  state: PipelineState,
  key: MarketKey,
  fixtureId: number,
): MarketState => {
  const existing = state.markets.get(key);
  if (existing) {
    return existing;
  }
  const created: MarketState = {
    fixtureId,
    history: new Map(),
    lastFairProb: new Map(),
    lastOdds: new Map(),
  };
  state.markets.set(key, created);
  return created;
};

/**
 * Fold one odds update into the per-market state and, if a steam or divergence signal
 * clears the risk manager, commit one decision for that market. At most one decision is
 * taken per market (actedMarkets), so a market that keeps moving is not re-entered.
 * Returns the number of decisions committed (0 or 1).
 */
const handleOdds = async (
  state: PipelineState,
  envelope: FeedEnvelope<OddsUpdate>,
  config: PipelineConfig,
  sink: PipelineSink,
): Promise<number> => {
  const odds = envelope.payload;
  const nowMs = envelope.receivedAtMs;
  const fairBookResult = computeFairBook(odds.lines, config.devigMethod);
  if (!fairBookResult.ok) {
    return 0;
  }
  const fairBook = fairBookResult.value;
  const market = getOrCreateMarket(state, odds.marketKey, odds.fixtureId);

  const oddsByOutcome = new Map<Outcome, DecimalOddsMilli>();
  for (const line of odds.lines) {
    oddsByOutcome.set(line.outcome, line.decimalOddsMilli);
  }

  for (const outcome of OUTCOMES_1X2) {
    const fairProb = fairProbOf(fairBook, outcome);
    if (fairProb === null) {
      continue;
    }
    market.lastFairProb.set(outcome, fairProb);
    const offered = oddsByOutcome.get(outcome);
    if (offered !== undefined) {
      market.lastOdds.set(outcome, offered);
    }
    const history = market.history.get(outcome) ?? [];
    history.push({ tsMs: odds.tsMs, fairProb });
    while (history.length > config.steamHistoryLimit) {
      history.shift();
    }
    market.history.set(outcome, history);
  }

  if (state.actedMarkets.has(odds.marketKey)) {
    return 0;
  }

  for (const outcome of OUTCOMES_1X2) {
    const fairProb = fairProbOf(fairBook, outcome);
    const offered = oddsByOutcome.get(outcome);
    if (fairProb === null || offered === undefined) {
      continue;
    }
    const history = market.history.get(outcome) ?? [];
    const signal =
      detectSteam(
        {
          fixtureId: odds.fixtureId,
          marketKey: odds.marketKey,
          outcome,
          tsMs: odds.tsMs,
          history,
          offeredOddsMilli: offered,
        },
        config.steam,
      ) ??
      detectDivergence(
        {
          fixtureId: odds.fixtureId,
          marketKey: odds.marketKey,
          outcome,
          tsMs: odds.tsMs,
          fairProb,
          offeredOddsMilli: offered,
        },
        config.divergence,
      );
    if (!signal) {
      continue;
    }
    const built = buildDecision(
      {
        signal,
        riskState: state.riskState,
        // dispersion 0: TxLINE serves a single consensus price, so there is no cross-book
        // spread for the outlier-odds breaker to act on and it is inert by design here; the
        // breaker engages only with multi-book dispersion. sourceRef: docs/audit/M8-audit.md.
        riskContext: { consensusFairProb: fairProb, dispersion: 0 },
        nowMs,
        feedTsMs: odds.tsMs,
      },
      config.decision,
    );
    if (!built.ok || built.value.kind !== 'decision') {
      continue;
    }
    const decision = built.value.decision;
    const index = state.decisionsCount;
    state.riskState = onCommit(state.riskState, {
      stake: decision.stake,
      fixtureId: decision.fixtureId,
      marketKey: decision.marketKey,
    });
    state.open.push({ index, decision, committedAtMs: nowMs });
    state.actedMarkets.add(odds.marketKey);
    state.decisionsCount += 1;
    const committed: CommittedPosition = { index, decision, committedAtMs: nowMs };
    await sink.onCommit(committed);
    return 1;
  }
  return 0;
};

/**
 * Whether an incoming score supersedes the one already tracked for a fixture. A final game
 * state always supersedes a non-final one and is never replaced by a non-final one (the
 * final result is sticky, A-9); among scores of the same finality a strictly higher seq
 * wins, so an out-of-order or duplicate lower-seq frame is dropped.
 * sourceRef: docs/research/M0-recon-findings.md O9 (final game states).
 */
const shouldReplaceScore = (existing: ScoreState, incoming: ScoreUpdate): boolean => {
  const existingFinal = isFinalGameState(existing.gameState);
  const incomingFinal = isFinalGameState(incoming.gameState);
  if (existingFinal !== incomingFinal) {
    return incomingFinal;
  }
  return incoming.seq > existing.seq;
};

/**
 * Track the score a fixture's bets will settle against, with a defined precedence so an
 * out-of-order, duplicate, or post-final correction frame cannot corrupt it: a final whistle
 * is sticky and a strictly higher seq wins among same-finality updates. The chosen seq is
 * recorded as settledSeq, the exact seq the on-chain proof is fetched for, so it must be the
 * true final one.
 */
const handleScore = (state: PipelineState, score: ScoreUpdate): void => {
  if (score.homeGoals === null || score.awayGoals === null) {
    return;
  }
  const existing = state.scores.get(score.fixtureId);
  if (existing !== undefined && !shouldReplaceScore(existing, score)) {
    return;
  }
  state.scores.set(score.fixtureId, {
    homeGoals: score.homeGoals,
    awayGoals: score.awayGoals,
    tsMs: score.tsMs,
    seq: score.seq,
    gameState: score.gameState,
  });
};

/**
 * Settle one open position against a tracked score: derive the 1X2 result, compute PnL,
 * fold it into the risk state, and emit it to the sink with the closing fair probability
 * (for CLV) and the settled seq (for the on-chain proof). Idempotent per index, so the
 * final-whistle path and the end-of-feed sweep cannot double-settle one position.
 */
const settlePosition = async (
  state: PipelineState,
  position: OpenPosition,
  score: ScoreState,
  sink: PipelineSink,
): Promise<boolean> => {
  if (state.settled.has(position.index)) {
    return false;
  }
  const result = resultOf(score.homeGoals, score.awayGoals);
  const won = result === position.decision.outcome;
  const pnl = computePnl(won, position.decision.stake, position.decision.entryOddsMilli);
  state.riskState = onSettlement(state.riskState, {
    stake: position.decision.stake,
    pnl,
    fixtureId: position.decision.fixtureId,
    marketKey: position.decision.marketKey,
  });
  // Closing line value uses the most recent consensus fair probability BY TIMESTAMP for the
  // backed outcome (robust to out-of-order arrival). When no observation arrived after the
  // entry, the closing line is unknown: fall back to the entry prob and flag it not-known,
  // so the backtest can exclude it from CLV rather than count a false zero.
  const outcomeHistory =
    state.markets.get(position.decision.marketKey)?.history.get(position.decision.outcome) ?? [];
  let latestObservation: ProbObservation | undefined;
  for (const observation of outcomeHistory) {
    if (latestObservation === undefined || observation.tsMs > latestObservation.tsMs) {
      latestObservation = observation;
    }
  }
  const hasClosingLine =
    latestObservation !== undefined && latestObservation.tsMs > position.decision.tsMs;
  const closingFairProb =
    hasClosingLine && latestObservation !== undefined
      ? latestObservation.fairProb
      : position.decision.fairProb;
  state.settled.add(position.index);
  const settledPosition: SettledPosition = {
    index: position.index,
    decision: position.decision,
    result,
    won,
    pnl,
    settledAtMs: score.tsMs,
    settledSeq: score.seq,
    closingFairProb,
    closingFairProbKnown: hasClosingLine,
  };
  await sink.onSettle(settledPosition);
  return true;
};

/**
 * Settle every still-open position on one fixture against its final-whistle score. This is
 * the live settlement trigger: a never-ending SSE feed settles when a match ends, not when
 * the feed completes.
 */
const settleFinalFixture = async (
  state: PipelineState,
  fixtureId: number,
  sink: PipelineSink,
): Promise<void> => {
  const score = state.scores.get(fixtureId);
  // Only ever settle against a final-whistle score. handleScore keeps a final score sticky,
  // so the tracked score here is the final one; this guard makes that invariant explicit and
  // robust if the tracking policy ever changes.
  if (score === undefined || !isFinalGameState(score.gameState)) {
    return;
  }
  for (const position of state.open) {
    if (position.decision.fixtureId === fixtureId) {
      await settlePosition(state, position, score, sink);
    }
  }
};

/**
 * End-of-feed sweep: settle any position not already settled by a final whistle against its
 * fixture's FINAL score. Covers a replay window that ends after the final whistle. A fixture
 * that never reached a final state (feed cut off, abandoned match) is left open and
 * unrealized, never settled against an in-running snapshot, so a backtest never books a result
 * for a match that did not actually end. sourceRef: A-9.
 */
const settleAll = async (state: PipelineState, sink: PipelineSink): Promise<void> => {
  for (const position of state.open) {
    const score = state.scores.get(position.decision.fixtureId);
    if (score !== undefined && isFinalGameState(score.gameState)) {
      await settlePosition(state, position, score, sink);
    }
  }
};

/**
 * Drive a Feed through the production decision path: de-vig each odds update to a fair
 * book, detect steam or divergence, size and risk-check with buildDecision, and commit
 * at most one decision per market. Scores are tracked as they arrive and every open
 * position is settled against the final score when the feed completes. Pure: it does no
 * IO and reads time from the feed envelope, so live (LiveSseFeed) and replay (ReplayFeed)
 * run identical code and a green replay is evidence about live behaviour.
 */
export const runPipeline = async (
  feed: Feed,
  sink: PipelineSink,
  config: PipelineConfig,
): Promise<PipelineResult> => {
  const state: PipelineState = {
    riskState: createRiskState(config.startingBankroll),
    markets: new Map(),
    scores: new Map(),
    open: [],
    actedMarkets: new Set(),
    settled: new Set(),
    decisionsCount: 0,
  };
  let committed = 0;
  let eventsProcessed = 0;
  for await (const event of feed.events()) {
    eventsProcessed += 1;
    if (event.kind === 'odds') {
      committed += await handleOdds(state, event.envelope, config, sink);
    } else if (event.kind === 'score') {
      const score = event.envelope.payload;
      handleScore(state, score);
      if (isFinalGameState(score.gameState)) {
        await settleFinalFixture(state, score.fixtureId, sink);
      }
    }
  }
  await settleAll(state, sink);
  return {
    committed,
    settled: state.settled.size,
    finalBankroll: state.riskState.bankroll,
    eventsProcessed,
  };
};
