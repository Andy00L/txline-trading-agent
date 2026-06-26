import { buildDecision, type DecisionConfig } from '../decision/build.js';
import type { Decision } from '../domain/decision.js';
import type { DevigMethod } from '../domain/fairbook.js';
import { fairProbOf } from '../domain/fairbook.js';
import type { OddsUpdate } from '../domain/events.js';
import { OUTCOMES_1X2, type MarketKey, type Outcome } from '../domain/market.js';
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

type ScoreState = { readonly homeGoals: number; readonly awayGoals: number; readonly tsMs: number };

type OpenPosition = { readonly index: number; readonly decision: Decision; readonly committedAtMs: number };

type PipelineState = {
  riskState: RiskState;
  readonly markets: Map<MarketKey, MarketState>;
  readonly scores: Map<number, ScoreState>;
  readonly open: OpenPosition[];
  readonly actedMarkets: Set<MarketKey>;
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

/** Track the latest fully-scored update per fixture; the final one settles the bets. */
const handleScore = (
  state: PipelineState,
  homeGoals: number | null,
  awayGoals: number | null,
  fixtureId: number,
  tsMs: number,
): void => {
  if (homeGoals === null || awayGoals === null) {
    return;
  }
  state.scores.set(fixtureId, { homeGoals, awayGoals, tsMs });
};

/** Settle every open position against the final tracked score for its fixture. */
const settleAll = async (
  state: PipelineState,
  sink: PipelineSink,
): Promise<number> => {
  let settled = 0;
  for (const position of state.open) {
    const score = state.scores.get(position.decision.fixtureId);
    if (!score) {
      continue;
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
    const closingFairProb =
      state.markets.get(position.decision.marketKey)?.lastFairProb.get(position.decision.outcome) ??
      position.decision.fairProb;
    const settledPosition: SettledPosition = {
      index: position.index,
      decision: position.decision,
      result,
      won,
      pnl,
      settledAtMs: score.tsMs,
      closingFairProb,
    };
    await sink.onSettle(settledPosition);
    settled += 1;
  }
  return settled;
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
      handleScore(state, score.homeGoals, score.awayGoals, score.fixtureId, score.tsMs);
    }
  }
  const settled = await settleAll(state, sink);
  return {
    committed,
    settled,
    finalBankroll: state.riskState.bankroll,
    eventsProcessed,
  };
};
