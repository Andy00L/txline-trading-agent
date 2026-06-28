import { buildDecision, type DecisionConfig } from '../decision/build.js';
import type { Decision } from '../domain/decision.js';
import type { DevigMethod, FairBook } from '../domain/fairbook.js';
import { fairProbOf } from '../domain/fairbook.js';
import type { FixtureUpdate, OddsUpdate, ScoreUpdate } from '../domain/events.js';
import { OUTCOMES_1X2, type MarketKey, type OddsLine, type Outcome } from '../domain/market.js';
import { isFinalGameState } from '../domain/score-state.js';
import type { Feed, FeedEnvelope } from '../feed.js';
import { computeFairBook } from '../quant/devig.js';
import {
  applyEloMatch,
  decorrelationMultiplier,
  eloMatchProbs,
  type EloOverlayConfig,
} from '../quant/elo.js';
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
import {
  detectCrossMarketValue,
  type CrossMarketConfig,
  type OverUnderMarket,
} from '../signal/cross-market.js';
import type { Signal } from '../signal/types.js';
import { clampProb, type DecimalOddsMilli, type MicroUsd, type Prob } from '../units.js';
import type { CommittedPosition, PipelineSink, SettledPosition } from './sink.js';

export type PipelineConfig = {
  readonly devigMethod: DevigMethod;
  readonly steam: SteamConfig;
  readonly divergence: DivergenceConfig;
  readonly decision: DecisionConfig;
  readonly startingBankroll: MicroUsd;
  /** Cap on the per-outcome fair-probability history kept for steam detection. */
  readonly steamHistoryLimit: number;
  /** When set, the pipeline runs the cross-market relative-value strategy (one decision per
   * fixture, sized by the goals-model edge) instead of the per-market steam/divergence path.
   * sourceRef: docs/research/quant-methods.md (cross-market relative value). */
  readonly crossMarket?: CrossMarketConfig;
  /** When set (cross-market path only), an independent Elo rating modulates the cross-market
   * stake through its market-decorrelated residual: a bounded confidence weight, never a gate.
   * Absent leaves the stake untouched. sourceRef: quant/elo.ts; docs/research/quant-methods.md. */
  readonly eloOverlay?: EloOverlayConfig;
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

/** The latest full-game odds surface for one fixture: the 1X2 lines plus the Over/Under
 * markets keyed by total-goals line, joined for the cross-market goals-model fit. */
type FixtureSurface = {
  match: { readonly lines: readonly OddsLine[]; readonly marketKey: MarketKey; readonly tsMs: number } | null;
  readonly overUnder: Map<number, readonly OddsLine[]>;
  /** Feed timestamp of the last cross-market fit for this fixture, for refit throttling. */
  lastFitMs: number | null;
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
  /** Per-fixture joined surface for the cross-market strategy. */
  readonly surfaces: Map<number, FixtureSurface>;
  /** Scheduled kickoff (ms) per fixture, read from the scores channel; gates cross-market entry
   * to the near-kickoff window. */
  readonly fixtureStartMs: Map<number, number>;
  readonly scores: Map<number, ScoreState>;
  /** Participant (team) ids per fixture, from the fixtures channel, keying the Elo ratings. */
  readonly fixtureTeams: Map<number, { readonly p1Id: number; readonly p2Id: number }>;
  /** Independent Elo ratings by participant id, seeded then evolved walk-forward from finalized
   * results; read by the decorrelation overlay, empty when the overlay is off. */
  readonly eloRatings: Map<number, number>;
  /** Fixtures already folded into the Elo ratings, so each finalized result updates them once. */
  readonly ratedFixtures: Set<number>;
  readonly open: OpenPosition[];
  readonly actedMarkets: Set<MarketKey>;
  /** Fixtures already acted on by the cross-market path, so at most one decision is taken
   * per fixture even as its surface keeps updating. */
  readonly actedFixtures: Set<number>;
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

const oddsByOutcomeOf = (lines: readonly OddsLine[]): Map<Outcome, DecimalOddsMilli> => {
  const oddsByOutcome = new Map<Outcome, DecimalOddsMilli>();
  for (const line of lines) {
    oddsByOutcome.set(line.outcome, line.decimalOddsMilli);
  }
  return oddsByOutcome;
};

/**
 * Record one fair-book observation into a market's per-outcome state: the latest fair
 * probability and offered odds, and the bounded fair-probability history that steam
 * detection and Closing Line Value read. Shared by the steam and cross-market paths.
 */
const recordMarketObservation = (
  market: MarketState,
  fairBook: FairBook,
  oddsByOutcome: ReadonlyMap<Outcome, DecimalOddsMilli>,
  tsMs: number,
  historyLimit: number,
): void => {
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
    history.push({ tsMs, fairProb });
    while (history.length > historyLimit) {
      history.shift();
    }
    market.history.set(outcome, history);
  }
};

/**
 * Commit one decision: assign the next monotonic index, fold it into the risk state and the
 * open set, advance the counter, and emit it to the sink. Shared by every signal path.
 */
const commitDecision = async (
  state: PipelineState,
  decision: Decision,
  nowMs: number,
  sink: PipelineSink,
): Promise<void> => {
  const index = state.decisionsCount;
  state.riskState = onCommit(state.riskState, {
    stake: decision.stake,
    fixtureId: decision.fixtureId,
    marketKey: decision.marketKey,
  });
  state.open.push({ index, decision, committedAtMs: nowMs });
  state.decisionsCount += 1;
  const committed: CommittedPosition = { index, decision, committedAtMs: nowMs };
  await sink.onCommit(committed);
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
  const oddsByOutcome = oddsByOutcomeOf(odds.lines);
  recordMarketObservation(market, fairBook, oddsByOutcome, odds.tsMs, config.steamHistoryLimit);

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
    state.actedMarkets.add(odds.marketKey);
    await commitDecision(state, decision, nowMs, sink);
    return 1;
  }
  return 0;
};

/**
 * The bounded market-decorrelation stake multiplier for a cross-market signal: map the fixture's
 * two participants to their independent Elo ratings, take the rating's probability for the backed
 * outcome (participant 1 is the home side), and weigh it against the market consensus the signal
 * exposes. Returns 1 (a no-op) when the overlay is off, the signal carries no market consensus, or
 * the fixture's participants are not yet known. sourceRef: quant/elo.ts.
 */
const crossMarketSizeMultiplier = (
  state: PipelineState,
  signal: Signal,
  overlay: EloOverlayConfig | undefined,
): number => {
  if (overlay === undefined || signal.marketProb === undefined) {
    return 1;
  }
  const teams = state.fixtureTeams.get(signal.fixtureId);
  if (teams === undefined) {
    return 1;
  }
  const ratingHome = state.eloRatings.get(teams.p1Id) ?? overlay.elo.initialRating;
  const ratingAway = state.eloRatings.get(teams.p2Id) ?? overlay.elo.initialRating;
  const probs = eloMatchProbs(ratingHome, ratingAway, overlay.neutral, overlay.elo, overlay.prob);
  const ratingProb =
    signal.outcome === 'home' ? probs.home : signal.outcome === 'draw' ? probs.draw : probs.away;
  return decorrelationMultiplier(clampProb(ratingProb), signal.marketProb, overlay.decorrelation);
};

/**
 * Fold one full-game odds update into the fixture's joined surface (1X2 + Over/Under), and
 * if the cross-market goals model finds a 1X2 leg priced longer than the joint fit implies
 * and it clears the risk manager, commit one decision. At most one decision is taken per
 * fixture (actedFixtures). First-half markets are ignored, so a bet is never settled against
 * the wrong score. Returns the number of decisions committed (0 or 1).
 */
const handleCrossMarketOdds = async (
  state: PipelineState,
  envelope: FeedEnvelope<OddsUpdate>,
  config: PipelineConfig,
  crossConfig: CrossMarketConfig,
  sink: PipelineSink,
): Promise<number> => {
  const odds = envelope.payload;
  const nowMs = envelope.receivedAtMs;
  // Full-game markets only: a first-half (half=1) market settles on a different score, so it
  // must never be traded against the full-time result. sourceRef: market-taxonomy probe 2026-06-27.
  if (odds.period !== 'full-game') {
    return 0;
  }

  const surface = state.surfaces.get(odds.fixtureId) ?? {
    match: null,
    overUnder: new Map(),
    lastFitMs: null,
  };
  state.surfaces.set(odds.fixtureId, surface);
  if (odds.marketKind === '1x2') {
    surface.match = { lines: odds.lines, marketKey: odds.marketKey, tsMs: odds.tsMs };
    // Record the de-vigged 1X2 consensus history so Closing Line Value reads the market line (not
    // the model fair) at entry and at close, but only PRE-KICKOFF (inRunning false): an in-play
    // price (the draw prob collapses after a goal) is not part of the closing line, and the flood
    // of in-play updates would evict the pre-match closing observation under the history cap.
    // sourceRef: docs/research/quant-methods.md item 6.
    if (!odds.inRunning) {
      const fairBook = computeFairBook(odds.lines, crossConfig.devigMethod);
      if (fairBook.ok) {
        const market = getOrCreateMarket(state, odds.marketKey, odds.fixtureId);
        recordMarketObservation(
          market,
          fairBook.value,
          oddsByOutcomeOf(odds.lines),
          odds.tsMs,
          config.steamHistoryLimit,
        );
      }
    }
  } else if (odds.marketKind === 'over-under' && odds.line !== null) {
    surface.overUnder.set(odds.line, odds.lines);
  } else {
    return 0;
  }

  if (state.actedFixtures.has(odds.fixtureId)) {
    return 0;
  }
  const matchState = surface.match;
  if (matchState === null || surface.overUnder.size === 0) {
    return 0;
  }
  // Time-to-kickoff gate: trade only the liquid near-kickoff window, and only once kickoff is
  // known from the scores channel (which excludes far-future fixtures whose scores have not yet
  // started, the source of thin-market false signals). sourceRef: R2 (condition on time-to-kickoff).
  const startMs = state.fixtureStartMs.get(odds.fixtureId);
  if (startMs === undefined) {
    return 0;
  }
  const leadMs = startMs - nowMs;
  if (leadMs < crossConfig.minLeadMs || leadMs > crossConfig.maxLeadMs) {
    return 0;
  }
  // Throttle the goals-model fit (the per-update cost): skip if the configured gap has not
  // elapsed since the last fit for this fixture. The mispricing persists across updates, so this
  // only spaces re-evaluation; it does not change which signal is found.
  if (
    crossConfig.minRefitMs > 0 &&
    surface.lastFitMs !== null &&
    odds.tsMs - surface.lastFitMs < crossConfig.minRefitMs
  ) {
    return 0;
  }
  surface.lastFitMs = odds.tsMs;
  const overUnder: OverUnderMarket[] = [...surface.overUnder.entries()].map(([line, lines]) => ({
    line,
    lines,
  }));
  const signalResult = detectCrossMarketValue(
    {
      fixtureId: odds.fixtureId,
      marketKey: matchState.marketKey,
      tsMs: odds.tsMs,
      matchLines: matchState.lines,
      overUnder,
    },
    crossConfig,
  );
  if (!signalResult.ok || signalResult.value === null) {
    return 0;
  }
  const signal = signalResult.value;
  const built = buildDecision(
    {
      signal,
      riskState: state.riskState,
      riskContext: { consensusFairProb: signal.fairProb, dispersion: 0 },
      nowMs,
      feedTsMs: odds.tsMs,
      sizeMultiplier: crossMarketSizeMultiplier(state, signal, config.eloOverlay),
    },
    config.decision,
  );
  if (!built.ok || built.value.kind !== 'decision') {
    return 0;
  }
  state.actedFixtures.add(odds.fixtureId);
  await commitDecision(state, built.value.decision, nowMs, sink);
  return 1;
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
  // Record the scheduled kickoff from every record, including pre-match "scheduled" ones that
  // carry no goals, so the cross-market entry gate knows time-to-kickoff before the match starts.
  if (score.startTimeMs !== null) {
    state.fixtureStartMs.set(score.fixtureId, score.startTimeMs);
  }
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
 * Capture a fixture's participants from the fixtures channel, so the Elo overlay can key its
 * ratings by stable team id. Idempotent: a later record for the same fixture refreshes the map.
 */
const handleFixture = (state: PipelineState, fixture: FixtureUpdate): void => {
  state.fixtureTeams.set(fixture.fixtureId, {
    p1Id: fixture.participant1Id,
    p2Id: fixture.participant2Id,
  });
};

/**
 * Fold one fixture's final result into the Elo ratings, once. This runs only at the final whistle,
 * after any decision on this fixture was committed pre-kickoff, so the ratings a fixture's own
 * decision reads reflect only earlier finalized matches (strictly walk-forward). A fixture whose
 * participants never arrived on the fixtures channel is skipped, since its teams cannot be keyed.
 */
const updateRatingsForFinal = (
  state: PipelineState,
  fixtureId: number,
  overlay: EloOverlayConfig | undefined,
): void => {
  if (overlay === undefined || state.ratedFixtures.has(fixtureId)) {
    return;
  }
  const teams = state.fixtureTeams.get(fixtureId);
  const score = state.scores.get(fixtureId);
  if (teams === undefined || score === undefined) {
    return;
  }
  state.ratedFixtures.add(fixtureId);
  const updated = applyEloMatch(
    state.eloRatings,
    {
      homeTeam: teams.p1Id,
      awayTeam: teams.p2Id,
      homeGoals: score.homeGoals,
      awayGoals: score.awayGoals,
      neutral: overlay.neutral,
    },
    overlay.elo,
  );
  // applyEloMatch only changes the two participants; apply those in place so the rating table
  // reference on the state stays stable.
  const ratingHome = updated.get(teams.p1Id);
  const ratingAway = updated.get(teams.p2Id);
  if (ratingHome !== undefined) {
    state.eloRatings.set(teams.p1Id, ratingHome);
  }
  if (ratingAway !== undefined) {
    state.eloRatings.set(teams.p2Id, ratingAway);
  }
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
  // Closing Line Value compares the market (de-vigged 1X2 consensus) line for the backed outcome
  // at entry against the CLOSING line, both BY TIMESTAMP (robust to out-of-order arrival). The
  // entry consensus is the latest observation at or before entry; the close is the latest
  // observation that is after entry but still BEFORE kickoff, because an in-play price (after a
  // goal the draw prob collapses) is not a closing line. When kickoff is unknown the close falls
  // back to the last observation after entry. When no such observation exists the closing line is
  // unknown: fall back to the entry consensus and flag it not-known, so the backtest excludes it
  // from CLV rather than counting a false zero. sourceRef: docs/research/quant-methods.md item 6.
  const startMs = state.fixtureStartMs.get(position.decision.fixtureId);
  const outcomeHistory =
    state.markets.get(position.decision.marketKey)?.history.get(position.decision.outcome) ?? [];
  let entryObservation: ProbObservation | undefined;
  let closingObservation: ProbObservation | undefined;
  for (const observation of outcomeHistory) {
    if (
      observation.tsMs <= position.decision.tsMs &&
      (entryObservation === undefined || observation.tsMs > entryObservation.tsMs)
    ) {
      entryObservation = observation;
    }
    const beforeKickoff = startMs === undefined || observation.tsMs < startMs;
    if (
      observation.tsMs > position.decision.tsMs &&
      beforeKickoff &&
      (closingObservation === undefined || observation.tsMs > closingObservation.tsMs)
    ) {
      closingObservation = observation;
    }
  }
  const entryConsensusProb = entryObservation?.fairProb ?? position.decision.fairProb;
  const hasClosingLine = closingObservation !== undefined;
  const closingFairProb =
    closingObservation !== undefined ? closingObservation.fairProb : entryConsensusProb;
  state.settled.add(position.index);
  const settledPosition: SettledPosition = {
    index: position.index,
    decision: position.decision,
    result,
    won,
    pnl,
    settledAtMs: score.tsMs,
    settledSeq: score.seq,
    entryConsensusProb,
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
    surfaces: new Map(),
    fixtureStartMs: new Map(),
    scores: new Map(),
    fixtureTeams: new Map(),
    eloRatings: new Map<number, number>(config.eloOverlay?.seed ?? []),
    ratedFixtures: new Set(),
    open: [],
    actedMarkets: new Set(),
    actedFixtures: new Set(),
    settled: new Set(),
    decisionsCount: 0,
  };
  let committed = 0;
  let eventsProcessed = 0;
  for await (const event of feed.events()) {
    eventsProcessed += 1;
    if (event.kind === 'odds') {
      committed +=
        config.crossMarket !== undefined
          ? await handleCrossMarketOdds(state, event.envelope, config, config.crossMarket, sink)
          : await handleOdds(state, event.envelope, config, sink);
    } else if (event.kind === 'score') {
      const score = event.envelope.payload;
      handleScore(state, score);
      if (isFinalGameState(score.gameState)) {
        updateRatingsForFinal(state, score.fixtureId, config.eloOverlay);
        await settleFinalFixture(state, score.fixtureId, sink);
      }
    } else if (event.kind === 'fixture') {
      handleFixture(state, event.envelope.payload);
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
