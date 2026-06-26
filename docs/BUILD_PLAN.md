# Build plan: TxLINE autonomous odds-trading agent (1st-place submission)

Standards loaded: coding-standards + security-audit

## Context

TxODDS is running a World Cup hackathon track, "Trading Tools and Agents" (Superteam Earn). Prize split 10k / 4k / 2k USDT. Submissions close 2026-07-19 23:59 UTC; winners 2026-07-29. The ask: a running autonomous agent or tool that ingests the TxLINE live feed (World Cup odds and scores, cryptographically anchored on Solana via Merkle roots) and executes a defined strategy without human intervention, live or on devnet. Judged on data ingestion, autonomous operation, deterministic and defensible logic, innovation, and production readiness. Heavy weight on the demo video, because matches finish after the deadline so there is no live activity to show at judging time.

Goal: the single best submission, first place only. No time limit, production-grade code, current tooling. The differentiator is not "an agent that prints signals" (most entries will be that). It is a trustless, non-cherry-picked on-chain track record built on TxLINE's own verification primitives, proven by a walk-forward backtest that runs the exact production code path. This file is the master build spec.

Project root: `~/txline-trading-agent` (WSL `/home/drew/txline-trading-agent`, UNC `\\wsl.localhost\ubuntu\home\drew\txline-trading-agent`). Currently holds only `.claude/` (standards, templates, and the copied design system under `.claude/design-handoff/`). Everything else is to be created.

## Product thesis: the trust chain

An autonomous, deterministic odds-trading agent whose every decision sits inside a verifiable chain:

1. Verified inputs. Every odds and score payload the agent acts on is checked against TxLINE's on-chain Merkle root before it can influence a trade.
2. Committed decisions. At decision time, before the outcome is known, the agent writes a hash of `(side, fair probability, entry odds, stake, signal, nonce)` on-chain. Decisions cannot be backfilled or cherry-picked after the fact.
3. Verified outcomes. When a market resolves, settlement does a CPI into TxLINE's `validate_stat`; PnL is only writable if the oracle-attested final score satisfies the claimed result.

Result: inputs, decisions, and outcomes are all independently auditable on-chain. For a data company whose product is verifiable on-chain sports data, this is the agent built natively on their trust model, and it answers the judges' core problem (no live matches at judging) with a committed, verifiable record plus a backtest rather than a live screenshot.

Strategy archetype (locked): consensus-divergence plus sharp-move (steam) detection. TxLINE serves consensus odds, so the tradeable signal is a book or in-play line diverging from devigged fair consensus, and broad fast line moves that precede settles. Primary market: 1X2 full-time (`market = 0`). Over/Under 2.5 is a documented extension.

## Confirmed groundwork (de-risks the build)

API (REST plus SSE, headers `Authorization: Bearer {jwt}` and `X-Api-Token: {api_token}`):

| Category | Endpoint | Use |
| --- | --- | --- |
| Auth | `POST /auth/guest/start` -> `{token}` (JWT 30d); `POST /api/token/activate` body `{txSig, walletSignature, leagues[]}` -> `{token}` | session, then API token |
| Odds | `GET /api/odds/stream` (SSE); `/api/odds/updates/{fixtureId}` (live 5-min cache); `/api/odds/updates/{epochDay}/{hourOfDay}/{interval}` (historical, interval 0..11); `/api/odds/snapshot/{fixtureId}?asOf=` ; `/api/odds/validation?messageId=` (Merkle proof) | live + replay + verify |
| Scores | `GET /api/scores/stream` (SSE); `/api/scores/updates/{fixtureId}`; `/api/scores/historical/{fixtureId}`; `/api/scores/updates/{epochDay}/{hourOfDay}/{interval}`; `/api/scores/snapshot/{fixtureId}?asOf=`; `/api/scores/stat-validation?fixtureId&seq&statKey[&statKey2]` (three-stage proof) | live + replay + settle |
| Fixtures | `/api/fixtures/snapshot?startEpochDay&competitionId`; `/api/fixtures/updates/{epochDay}/{hourOfDay}`; `/api/fixtures/validation?fixtureId`; `/api/fixtures/batch-validation` | schedule + verify |

Odds object: `FixtureId(i64)`, `MessageId(string, keys the odds proof)`, `Ts(i64 ms)`, `Bookmaker`, `BookmakerId`, `SuperOddsType`, `InRunning(bool, in-play)`, `MarketPeriod?`, `MarketParameters?`, `PriceNames(string[])`, `Prices(i32[])`, `Pct(string[], implied prob or "NA")`. Roots publish every 5 minutes (odds, scores), daily (fixtures). No documented rate limit or SLA; gzip on SSE.

On-chain oracle `txoracle` v1.4.7 (Anchor 0.31.1), devnet program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`, mainnet `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`. It is a pure oracle: publishes roots (`insert_scores_root`, `insert_fixtures_root`, `insert_batch_root`) and verifies proofs on-chain (`validate_odds`, `validate_stat`, `validate_fixture`, `validate_fixture_batch`). No `settleTrade`, no escrow. Confirmed from the real IDL and `backup/examples/data_validation/*.ts`:

- `validate_stat(ts: i64, fixture_summary: ScoresBatchSummary, fixture_proof: Vec<ProofNode>, main_tree_proof: Vec<ProofNode>, predicate: TraderPredicate, stat_a: StatTerm, stat_b: Option<StatTerm>, op: Option<BinaryExpression>)` with a single read-only account `daily_scores_merkle_roots`. Writes no state, returns no data, reverts on failure. Calls need `setComputeUnitLimit(~10_000_000)`.
- Types: `ProofNode { hash: [u8;32], is_right_sibling: bool }`, `ScoreStat { key: u32, value: i32, period: i32 }`, `StatTerm { stat_to_prove: ScoreStat, event_stat_root: [u8;32], stat_proof: Vec<ProofNode> }`, `ScoresBatchSummary { fixture_id: i64, update_stats: ScoresUpdateStats, events_sub_tree_root: [u8;32] }`, `TraderPredicate { threshold: i32, comparison }`, `Comparison = GreaterThan|LessThan|EqualTo`, `BinaryExpression = Add|Subtract`.
- Scores roots PDA seed: `b"daily_scores_roots"` plus 2-byte LE `epoch_day`, where `epoch_day = floor(ts_ms / 86_400_000)` (`ts` is milliseconds). Odds use `b"daily_batch_roots"`; fixtures use `b"ten_daily_fixtures_roots"`.

## Architecture

TypeScript monorepo (pnpm workspaces plus Turborepo, single package manager), plus an Anchor (Rust) program. Project references so `core` type-checks standalone.

```
txline-trading-agent/
  pnpm-workspace.yaml  turbo.json  tsconfig.base.json  package.json  Anchor.toml
  programs/agent_ledger/        # our Solana program (Rust, Anchor 0.31.1)
  packages/
    core/            # PURE. quant + domain types + decision logic. zero IO.
    txline/          # TxLINE REST + SSE, zod schemas, LiveSseFeed + ReplayFeed, resilience.
    onchain-client/  # @solana/kit client: commit/settle, txline validate CPI args, proof submission.
    agent/           # composition root: feed -> core -> risk -> onchain. the runtime.
    backtest/        # replay harness, CLV/calibration/drawdown/walk-forward, report artifact.
    api/             # read-only HTTP + SSE projection of agent state.
    dashboard/       # Vite + React operator console. consumes api only.
  fixtures/          # captured real payloads: odds/ scores/ fixtures/ sse/ proofs/
  tools/capture/     # one-shot recorder: live API -> fixtures (dev only, never CI).
  docs/              # BRIEF.md, DECISIONS.md, research/*.md
  requirements.md
```

Dependency rule (acyclic, enforced by ESLint `no-restricted-imports` plus a CI grep): `core -> nothing`; `txline -> core`; `onchain-client -> core (+@solana/kit)`; `backtest -> core, txline`; `agent -> core, txline, onchain-client`; `api -> core, agent`; `dashboard -> api (HTTP only)`. If `core` needs the network, the design is wrong and the code moves up to `txline`/`agent`.

Design tenets: one code path for live and replay; full determinism (no `Date.now()`, no `Math.random()`, no map-order dependence in decision code; inject a `Clock` and seeded PRNG); zod at every ingress; errors-as-values end to end (the only `throw` is the outer CLI boundary); money as integers (`MicroUsd = bigint`, odds `DecimalOddsMilli` integer x1000); `core` is pure.

## On-chain program: `agent_ledger`

Our companion Anchor program. Paper trading only (paper USDC as `u64`, 6 implied decimals); nothing moves real funds on devnet.

Accounts:

- `Strategy` (one per agent strategy): `authority: Pubkey`, `strategy_id: u64`, `txline_program: Pubkey` (pinned CPI target, anti-swap), `starting_bankroll: u64`, `bankroll: u64`, `realized_pnl: i64`, `decisions_count: u64`, `open_count/settled_count: u64`, `wins/losses/pushes: u32`, `commit_log_root: [u8;32]` (rolling accumulator), `bump`. Seeds `[b"strategy", authority, strategy_id_le]`.
- `DecisionCommit` (one per decision, created at commit): `strategy`, `index: u64` (== `decisions_count` at creation, replay-proof), `commit_hash: [u8;32]`, `fixture_id: i64` (clear, routes settle), `market: u16` (clear), `commit_slot: u64`, `commit_unix_ts: i64`, `status: u8` (0 Open, 1 Settled, 2 Void), `outcome_side: u8`, `pnl: i64`, `settle_slot: u64`, `bump`. Seeds `[b"commit", strategy, index_le]`. In the clear: routing fields only. Sealed in `commit_hash` until reveal: side, fair probability, entry odds, stake, signal hash, nonce.

Commit-reveal binding: `commit_hash = keccak256(borsh(RevealArgs { strategy, index, fixture_id, market, side: u8, fair_prob_bps: u16, entry_odds_milli: u32, stake: u64, signal_hash: [u8;32], nonce: [u8;32] }))`. At settle the agent submits `RevealArgs` verbatim; the program recomputes keccak and requires equality, so side/price/stake are immutable post-commit.

Instructions (all signed by `Strategy.authority`):

- `initialize_strategy(strategy_id, txline_program, starting_bankroll)`.
- `commit_decision(commit_hash, fixture_id, market)`: init `DecisionCommit` at `index = decisions_count`, stamp `commit_slot`/`commit_unix_ts`, advance counters, fold `commit_log_root = hashv([commit_log_root, commit_hash, index_le])`, emit `DecisionCommitted`.
- `settle_decision(args: SettleArgs)`: in order, (1) check authority, (2) require `status == Open`, (3) require `keccak256(borsh(reveal)) == commit_hash`, (4) require `reveal.fixture_id/market == decision`, (5) require `txline_program == strategy.txline_program`, (6) derive the required predicate from `claimed_result` and require `op == Subtract`, `stat_b.is_some()` (Home -> `{GreaterThan,0}`, Draw -> `{EqualTo,0}`, Away -> `{LessThan,0}` over `home - away`), (7) CPI into `txline::validate_stat(...)` with `{ daily_scores_merkle_roots }` (reverts the whole settle if the proof is bad, the predicate is false, or the root is not posted), (8) outcome now proven == claimed; compute `won = (claimed_result == reveal.side)`, `pnl = won ? stake*(entry_odds_milli-1000)/1000 : -stake` (checked), update `decision` and `Strategy` accounting, (9) emit `DecisionSettled`.
- `void_decision(reveal, reason)`: match voided or postponed; require Open and keccak match; set Void, `pnl=0`, `pushes+=1`; guarded by a `VOID_GRACE` window after commit so it cannot dodge an imminent loss.

Verification approach (decided): CPI into `validate_stat` (option a). It is a pure assertion over a read-only account, so it composes under CPI with no writable-account conflict; success means not reverting, which is exactly the property we want. The predicate is derived from the claim on-chain, and `stat_a`/`stat_b` each carry their own Merkle proof to the oracle root, so a passing CPI can only mean the real result matches the claim. Proof bytes travel as settle-ix args, never stored on-chain, so account sizes are independent of proof depth. Rejected: reading a marker after a separate `validate_stat` (it writes nothing to read), and recomputing the three-stage proof ourselves (reimplements an undocumented layout).

Storage: Mode A for the demo (one `DecisionCommit` per decision; ~0.0021 SOL each, 104 matches x ~3 decisions ~ 0.65 SOL on devnet, best judge UX and a queryable account plus event per decision). Mode B (fold into `commit_log_root`, emit event, O(1) storage) is available with no schema change if scale demands.

CPI encoding route to confirm at M4: typed `declare_program!` (`cpi::validate_stat`) versus a hand-rolled `invoke` with `[discriminator(8) ++ borsh(args)]` and one `AccountMeta::new_readonly(daily_scores_merkle_roots)`. Re-derive the expected roots PDA from `ts` and `require_keys_eq!` before the CPI for a clean error.

Program files to create: `programs/agent_ledger/src/lib.rs` (entry plus the four instructions and the CPI), `state.rs` (`Strategy`, `DecisionCommit`, `RevealArgs`, `SettleArgs`), `txline_cpi.rs` (mirror `ProofNode`, `ScoreStat`, `StatTerm`, `ScoresBatchSummary`, `TraderPredicate`, `Comparison`, `BinaryExpression` plus the `validate_stat` builder), `errors.rs`.

## Off-chain packages

`core` (pure). Branded units in `core/units.ts`: `DecimalOddsMilli` (integer x1000), `Prob` ([0,1] float), `MicroUsd` (`bigint`). Domain types in `core/domain/`: `Fixture`, `OddsUpdate` (carries `messageId`, `lines: OddsLine[]` with `outcome: "home"|"draw"|"away"|"other"`, `decimalOddsMilli`, `impliedPct: Prob|null`), `ScoreUpdate` (carries `seq`, `score`, `stats`), `MarketKey = ${fixtureId}:${superOddsType}:${marketPeriod}:${marketParameters}`, plus `FairBook`, `Signal`, `Decision`, `Order`, `Position` (state machine `pending -> committed -> settled-win|settled-loss|voided`), `Settlement` (with `closingOddsMilli` for CLV).

Feed abstraction in `core` (types) implemented in `txline`:

```
FeedEvent = { kind: "odds"|"score"|"fixture"|"heartbeat"|"gap"|"feed-status", envelope: FeedEnvelope<...> }
FeedEnvelope<T> = { source: "live-sse"|"replay", seq: number, receivedAtMs: number, payload: T }
interface Feed { events(): AsyncIterable<FeedEvent>; stop(): Promise<void>; done(): Promise<FeedRunResult> }
```

`LiveSseFeed` wraps `/api/odds/stream` and `/api/scores/stream`, zod-parses each frame, assigns `seq`, runs reconnect plus gap-backfill. `ReplayFeed` reads `/updates/{epochDay}/{hourOfDay}/{interval}`, sorts deterministically by `(tsMs, stable tiebreak)`, emits the identical union with `source: "replay"`, and advances an injected `Clock` to each event's `tsMs`. The agent loop is `runPipeline(feed: Feed, ports: Ports)`; production passes `LiveSseFeed` plus the real Solana client, backtest passes `ReplayFeed` plus a recording mock. Same decision code between, so a green backtest is direct evidence about live behavior.

Quant signatures (pure, errors-as-values): `devigMultiplicative`, `devigShin` (bisection on the booksum constraint; sourceRef H. S. Shin 1991/1993 in a comment), `computeFairBook`, `detectDivergence`, `detectSteam`, `expectedValue`, `kellyStake` (fractional Kelly, clamp by `maxFractionOfBankroll`, quantize to integer stake), `buildCalibrationCurve` (Brier plus log loss).

Risk manager (pure reducer, no IO, no clock): `RiskConfig` (bankroll floor, per-market / per-fixture / total exposure caps, max stake per order, max concurrent positions, `staleFeedMs`, `outlierOddsZ`, `maxDailyDrawdown`); breakers `stale-feed | root-mismatch | outlier-odds | bankroll-floor | daily-drawdown | exposure-cap`; `evaluate`, `onAnomaly`, `onSettlement`, `reset`. `RiskContext` carries the consensus fair book plus dispersion so the outlier breaker needs no IO.

Verification module: `ProofTarget` (odds by `messageId`, score by `fixtureId, seq, statKey[, statKey2]`), `MerkleProof`, pure `verifyProof(proof, authoritativeRootHex): VerificationOutcome`, and an `OnChainRootVerifier` seam implemented by `onchain-client`. A `root-mismatch` becomes a risk anomaly tripping the breaker.

Resilience (in `txline`): SSE reconnect with exponential backoff plus full jitter; proactive JWT and API-token refresh, 401 -> one re-auth; gap detection (scores by `seq`, odds/fixtures by synthetic per-run `seq` plus interval index); replay-on-reconnect backfill via the `/updates/...` endpoints (the same code `ReplayFeed` uses); idempotency keyed by `MessageId` and `(fixtureId, seq)`; zod at ingress with field-path errors that never log secrets.

`OnChainPort` boundary (exactly two methods, so backtest swaps a recording mock): `commit(order) -> { positionId, txSig } | error` and `settle(position, finalScore) -> { settlement, txSig } | error`. `onchain-client` implements it with `@solana/kit` against `agent_ledger` and assembles the `validate_stat` proof args from `/api/scores/stat-validation`.

## Backtest harness (the proof centerpiece)

`packages/backtest` drives `ReplayFeed` over a captured fixture window through the real `runPipeline` with a `RecordingOnChainPort` (fills at recorded odds, settles against the final score), and computes: Closing Line Value (entry odds versus the last pre-kickoff snapshot per `MarketKey`, per-bet and aggregate, the primary edge proxy), calibration curve (predicted fair prob versus realized win rate, Brier and log loss), hit-rate versus implied, drawdown (equity curve, max drawdown), and a walk-forward split (params tuned in-sample, evaluated on a disjoint out-of-sample set, split by fixture/date, never by shuffling within a match). Output is a deterministic markdown plus self-contained HTML report (inline SVG, no external fetch) to `backtest/out/`. Same input produces a byte-identical report (timestamps from data, not the clock). This deliverable stands before the on-chain half is finished and is the heart of the demo.

## Dashboard (the vitrine)

Vite plus React operator console, reading `api` over HTTP/SSE only. It reuses the copied design system, which maps almost 1:1 onto this product: light "paper" aesthetic, one interactive blue `#2B5FD9`, one reserved green `#1F8A5B` for the verified stamp, mono with `tabular-nums` for all numbers. Component mapping from `.claude/design-handoff/stellar/project/`:

- `SSBidCard` (sealed bid plus commitment hash) -> committed-decision card (sealed signal, before outcome).
- `SSFlipCard` (sealed -> clearing price) -> commit-to-reveal flip showing the verified outcome and PnL.
- `SSStamp` "Verified on Soroban" -> "Verified on Solana" against the Merkle root.
- `SSPill` tones -> position states (open / committed / settled / void).
- `SSPhaseDot` and `PhaseCard` -> the autonomous pipeline (ingest -> verify -> signal -> commit -> settle).
- `SSHash` for odds/addresses, `SSCountdown` for the match clock.

Tabs: live feed plus consensus-versus-book divergence; signal log; open and settled positions with Solana Explorer (devnet) links; the CLV / backtest report. Re-themed and de-branded from "SealedStellar". Design tokens are reused from `ss-theme.css`; physical relocation of `design-handoff/` to project root is a scaffold detail at M7.

## Testing, security, standards

- `core`: golden-fixture unit tests (devig goldens including a Shin worked example, EV/Kelly goldens, planted-outlier divergence and fabricated-shortening steam, calibration on a synthetic calibrated sample, every risk cap/breaker crossed by one minor unit, a golden Merkle proof that recomputes to root and a flipped sibling byte that does not). Property tests (probs sum to 1; Shin reduces to multiplicative as z -> 0).
- `agent`/`backtest`: replay determinism (same log twice -> byte-identical `Decision[]`/`Position[]`), identical-path proof (same data as synthesized `LiveSseFeed` and as `ReplayFeed` -> matching `Decision[]`), gap/backfill recovery, golden backtest report (numeric fields versus a checked-in golden JSON plus markdown).
- `agent_ledger`: LiteSVM/Mollusk tests for the keccak binding and monotonic index and the predicate-from-claim derivation and PnL math; a devnet integration test calling the real `txline` program with a finished fixture's proof.
- CI gate: `pnpm -r typecheck && pnpm -r test && pnpm -r lint`, plus the standards greps (em/en dash, type-suppression, banned words) and the `core`-purity check.
- This project touches secrets (JWT, API token) and a trust boundary (external feed) and a payments-shaped flow (settlement), so the full REFERENCE_SECURITY_AUDIT runs at M8 before submission; always-on rules apply throughout. Secrets come from env, never written to a fixture, never logged.
- Reuse the conventions already proven in the sibling project `solana-token-extensions-skill/examples/mint-inspector` (errors-as-values, captured real fixtures with dated provenance comments, `tsc --noEmit` gating `vitest`, zod at the boundary, `@solana/kit`, no `any`). Match them rather than introducing new patterns.

## Milestones

| # | Milestone | Output |
| --- | --- | --- |
| M0 | Recon: confirm O1..O9 and A-1..A-9 against the live docs, IDL, and `backup/examples/`; get a devnet wallet, TxLINE token, devnet TxL; capture a first real fixture window; pin `units.ts` and zod schemas with sourced comments; fill `docs/BRIEF.md`, `docs/DECISIONS.md`, `requirements.md` | grounded specs, one verified payload spike |
| M1 | `core`: domain plus devig (multiplicative and Shin) plus EV plus Kelly plus calibration | golden suite green, pure |
| M2 | `txline`: schemas, REST, `LiveSseFeed`, `ReplayFeed`, resilience, idempotency | replay-determinism and identical-path tests green |
| M3 | `core`: consensus/divergence/steam plus risk manager plus decision reducer | signal/risk goldens green |
| M4 | `agent_ledger` plus `onchain-client`: commit/settle, validate_stat CPI, devnet deploy | commit and CPI-settle on devnet against the live oracle |
| M5 | `backtest`: harness, metrics, report | CLV/calibration/walk-forward report, the judging centerpiece |
| M6 | `agent` service plus `api` plus Docker | judge-runnable headless agent |
| M7 | `dashboard`: trader console wired to live and replay | the vitrine |
| M8 | full security audit, hardening, latency and e2e | audit report, fixes |
| M9 | submission: demo script and video, technical doc (endpoints used plus API feedback), devnet deploy, hosted dashboard, README, git handoff | submittable package |

## Open questions to confirm at M0 (do not guess; pin with sourced comments)

API: O1 `Prices[]` integer scaling (x1000 assumed) and whether only decimal odds appear. O2 exact 1X2 `PriceNames` labels/order and how `MarketPeriod`/`MarketParameters` separate full-time. O3 World Cup `CompetitionId` and `competition` string. O4 odds and score Merkle leaf byte construction (so pure `verifyProof` matches the chain). O5 how a 5-min root window is addressed on chain. O6 odds/fixtures ordering for gap detection. O7 SSE event names and whether `Last-Event-ID` resume exists. O8 confirm no rate limit / SLA. O9 which `gameState`/`statusSoccerId` marks a final settled result and void.

On-chain: A-3 which `ScoreStat.key` plus `period` encode home versus away final goals (pull a finished-fixture `/api/scores/stat-validation`); A-4 if unlabeled, derive home/away from `Fixture.participant1_is_home`; A-5 the CPI encoding route; A-7 `ts` is milliseconds (examples divide by 86_400_000); A-8 a full three-stage proof plus two `StatTerm`s fits one tx (else pick a smaller-proof stat); A-9 the chosen `period`/`seq` is the final score, not an in-running snapshot.

## How it maps to the judging criteria

| Criterion | Where it is won |
| --- | --- |
| Core functionality and data ingestion | SSE plus REST plus Merkle verify, live and replay |
| Autonomous operation | `runPipeline` runs unattended; commit and CPI-settle automated |
| Logic and code architecture | pure deterministic quant core, errors-as-values, full test suite |
| Innovation and novelty | trustless commit-reveal track record settled by CPI into the sponsor's own validator |
| Production readiness | Docker, metrics, reconnect/backfill, audit, latency numbers, integration with the sponsor program |

## Decisions taken (seed for docs/DECISIONS.md)

- Strategy: consensus-divergence plus sharp-move, primary market 1X2 full-time. Rejected: in-play market maker (harder to prove edge pre-deadline), agent-vs-agent (splits effort).
- Judge access: web dashboard plus devnet. Rejected: API-only (weaker demo).
- Trust model: commit-reveal plus CPI into `txline::validate_stat`. Rejected: own escrow (none exists in the oracle), off-chain-only PnL (not trustless).
- Stack: TS monorepo (pnpm plus Turborepo), `@solana/kit`, Anchor 0.31.1 program `agent_ledger`, Vite plus React dashboard. Storage Mode A for the demo. Money as integers, odds x1000 (confirm O1).

## Verification (end to end)

1. Static and unit: `pnpm -r typecheck && pnpm -r test && pnpm -r lint`; expect golden math, replay-determinism, and identical-path tests green, plus the standards greps and the `core`-purity check.
2. Program: `anchor test` for `agent_ledger` (LiteSVM/Mollusk for commit and PnL logic), then a devnet integration test that commits a decision and settles it by CPI into the live `txoracle` with a real finished-fixture proof from `/api/scores/stat-validation`; assert the settle reverts on a tampered proof and succeeds on the real one.
3. Backtest: `pnpm backtest -- --window <captured>` produces `backtest/out/report.html` and `report.md`; assert CLV, calibration, and walk-forward numbers match the checked-in golden.
4. Live smoke (needs devnet wallet plus API token): run the agent against the live SSE for a fixture window; observe `DecisionCommitted` txs on Solana Explorer (devnet) before kickoff, then settlement after the match; the dashboard shows ingest -> verify -> commit -> settle with explorer links and a verified stamp.
5. Demo: the 5-minute video walks the committed-before-kickoff record, a CPI-verified settlement, and the walk-forward CLV report.

## What I need from the human

1. Go-ahead to scaffold M0 (repo skeleton, `docs/` filled from this plan, capture and recon spikes).
2. Devnet wallet plus a TxLINE guest/subscription token (commercial fees waived for the hackathon) plus devnet TxL. Acquiring the token and funding the wallet needs your wallet; I build against the documented schema and captured fixtures until then.
3. The agent never runs git. Each milestone ends with a files-affected report and a ready-to-run `git add`/`commit`/`push` block for you.
