# Technical documentation

TxLINE autonomous odds-trading agent. This document covers the core idea, the business and
technical highlights, the exact TxLINE endpoints used, and our feedback on the TxLINE API.

## Core idea

An autonomous, deterministic agent that trades World Cup soccer odds on a cross-market
relative-value strategy and keeps a trustless on-chain track record:

1. Cross-market signal. For each fixture the agent fits one Dixon-Coles goals model
   (parametrized by supremacy = home minus away expected goals, and total = home plus away) jointly
   to the full odds surface the free tier serves: the 1X2 match-result market, the Over/Under
   total-goals ladder, and the Asian-Handicap ladder. It backs the 1X2 outcome the joint fit prices
   longer than the 1X2 line alone implies (the lagging leg, after Kaunitz et al. 2017), sized by a
   real positive Kelly edge and entered in the liquid near-kickoff window. A de-margined consensus
   cannot be out-forecast, so the edge is cross-market consistency and slow-leg timing, not a claim
   to beat an efficient market.
2. Committed decisions. Each decision is sealed on-chain before kickoff:
   `commit_hash = keccak256(borsh(strategy, index, fixture, market, side, fair prob, entry odds,
   stake, signal hash, nonce))`. Only routing fields (fixture, market) are in the clear; side,
   price, and stake stay sealed, so a decision cannot be backfilled or altered after the outcome.
3. Verified settlement. At settle the agent reveals the sealed fields and the program CPIs into
   `txoracle::validate_stat`. The 1X2 predicate is derived on-chain from the claim (home is
   `participant1 - participant2 > 0`, draw `== 0`, away `< 0`); the program writes PnL only if the
   proof passes, so the recorded outcome is proven against TxLINE's own oracle. A bad proof, a
   missing root, a wrong fixture, or a swapped stat reverts the whole settle.

The decision logic is one code path for live and replay, so the walk-forward backtest is direct
evidence about live behaviour rather than a separate simulation. The edge is reported honestly as
Closing Line Value (entry versus the last pre-kickoff consensus) with a bootstrap confidence
interval, the metric a professional trading desk tracks, alongside calibration and drawdown.

## Business highlights

- For a company whose product is verifiable on-chain sports data, this is an agent built natively
  on their trust model: it consumes the Merkle roots and settles by CPI into their own validator.
- It answers the judging problem directly. Because matches end after the deadline, a screenshot
  proves nothing; a commit-before-kickoff plus a CPI-verified settlement is a record no one can
  cherry-pick or backfill.
- The edge is measured honestly as Closing Line Value with a bootstrap confidence interval, the
  metric a professional trading desk tracks. Over the group stage (22 settled bets) the mean CLV is
  +0.0024 (95% CI [-0.0007, +0.0057]), with 59% of bets beating the pre-kickoff close, a marked
  improvement over the prior steam strategy's -0.0424 on 8 bets (12.5% positive). It is a small,
  honestly-bounded edge reported with calibration and drawdown alongside, not a cherry-picked ROI.
- Production-shaped: Docker, a read-only operator API and dashboard, reconnect plus gap-backfill,
  a security audit, and devnet integration with the sponsor's program.

## Technical highlights

- Strict monorepo layering enforced by ESLint and a CI grep: `core` is pure (no IO, no clock, no
  RNG, no chain client), so the quant is unit-testable and deterministic.
- The signal is a Dixon-Coles scoreline model (parametrized by supremacy and total goals) fitted by
  a deterministic grid search jointly to the 1X2, Over/Under, and Asian-Handicap markets; the 1X2 is
  de-vigged with Shin (favourite-longshot aware). The model fit, the cross-market value signal, the
  kickoff-gated entry, and the bootstrap Closing-Line-Value interval are all pure functions in
  `core` with golden tests.
- Errors as values end to end; the only `throw` is the process boundary. Money is integer
  micro-USD (`bigint`); odds are integer milli (decimal x1000). No floating point in money math.
- The commit-reveal binding is a keccak over a borsh layout that is byte-identical between the
  Rust program and the TypeScript client, pinned by a cross-language golden hash on both sides.
- `validate_stat` proof args are assembled from the three-stage scores proof and travel as
  instruction data, never stored on-chain, so account sizes are independent of proof depth.
- Resilience: SSE reconnect with exponential backoff and full jitter, one JWT re-auth on 401,
  REST gap-backfill on reconnect, and idempotency keyed by `MessageId` and `(fixtureId, seq)`.
- A broad TypeScript test suite plus Rust program tests; a security audit (docs/audit/M8-audit.md)
  that found and fixed two critical on-chain settlement trust gaps, re-proven on devnet. A later
  upgrade pass added the cross-market goals model and fixed three replay-feed correctness bugs:
  settlement now keys on the numeric `StatusId` (the textual `GameState` is frozen at "scheduled" on
  the `/updates` feed), Closing Line Value is measured against the pre-kickoff close (never an
  in-play price), and first-half markets are no longer traded against the full-time score.

## TxLINE endpoints used

Headers on every authed call: `Authorization: Bearer {jwt}` and `X-Api-Token: {api_token}`.
Base host: `txline-dev.txodds.com` (both auth and data).

| Endpoint | Method | Where it is used |
| --- | --- | --- |
| `/auth/guest/start` | POST | Start a guest session, obtain the 30-day JWT (`TxlineClient.startGuestSession`, and the 401 re-auth path). |
| `/api/token/activate` | POST | Mint the free World Cup API token after the on-chain `subscribe`, in the token-activation flow. |
| `/api/odds/stream` | GET (SSE) | Live odds. Opened and merged by `FetchSseConnector`, fed into `LiveSseFeed`. |
| `/api/scores/stream` | GET (SSE) | Live scores. Merged with the odds stream by `FetchSseConnector`. |
| `/api/odds/updates/{epochDay}/{hourOfDay}/{interval}` | GET | Historical odds for replay and the reconnect gap-backfill (`ReplayFeed`, `LiveSseFeed.backfill`). |
| `/api/scores/updates/{epochDay}/{hourOfDay}/{interval}` | GET | Historical scores for replay and backfill. |
| `/api/odds/snapshot/{fixtureId}` | GET | Point-in-time odds snapshot (`TxlineClient.getOddsSnapshot`). |
| `/api/scores/snapshot/{fixtureId}` | GET | Point-in-time scores snapshot (`TxlineClient.getScoresSnapshot`). |
| `/api/scores/stat-validation?fixtureId&seq&statKey&statKey2` | GET | The three-stage Merkle proof for the home and away goal stats, the input to the `validate_stat` settle CPI (`TxlineClient.getScoresStatValidation`). |
| `/api/odds/validation?messageId&ts` | GET | The Merkle proof and snapshot for one odds update, keyed by its `MessageId` and `Ts`; the input to the `prove_entry_odds` / `validate_odds` entry-odds proof (`TxlineClient.getOddsValidation`). |

On-chain, the agent CPIs into `txoracle::validate_stat` (devnet
`6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`) with a single read-only `daily_scores_merkle_roots`
account re-derived from the proof timestamp.

## Extensions: two now implemented, one scoped

Two extensions the design accommodated are now built (the entry-odds proof is wired into the live
agent loop); the third is scoped.

Implemented:

- Prove the inputs on-chain too (`prove_entry_odds` into `validate_odds`). After settle the agent
  re-checks the sealed reveal, binds the snapshot's price for the committed side to the sealed
  `entry_odds_milli`, re-derives `daily_odds_merkle_roots` from the odds timestamp, and CPIs into
  `validate_odds`, so the committed entry price is proven a genuine TxLINE record, not just sealed:
  inputs and outcomes are both proven against TxODDS's own roots. It is covered by program tests and
  a cross-language borsh golden, and is sized to a legacy transaction (worst-case about 886 bytes of
  instruction data, under the 1232-byte limit, measured on a real proof), so no Address Lookup Table
  is needed. It is now deployed and proven on devnet, and wired into the live agent loop: the sink
  runs `prove_entry_odds` after each settle (best-effort, re-discovering the sealed entry odds record
  and proving it; the settle still stands as the second link if the record has aged out of the
  validation window). `prove:e2e` proved an entry price against the published odds Merkle root (a
  `DecisionOddsProven` decision) and rejected a tampered price, so all three trust links (commit,
  prove entry odds, settle) run on the live program.
- Layer an independent rating on, decorrelated. A frozen World Football Elo rating is added not as a
  goals-model fit prior (which double-counts the market) but as a market-decorrelation overlay: the
  agent acts only on the rating's residual after orthogonalizing against the consensus, as a bounded
  confidence weight on the Kelly stake. The literature is explicit that a standalone rating does not
  beat a de-margined consensus (Hvattum-Arntzen 2010; Wunderlich-Memmert 2018) and that a correlated
  model is unprofitable however accurate (Hubacek et al. 2019), so this is an honest calibration
  overlay, not a claimed new edge; the sweep reports Closing Line Value with and without it.

Scoped (not yet wired):

- Bet and settle Over/Under directly. `validate_stat` accepts an `Add` binary expression (the
  predicate op enum is exactly `{Add, Subtract}`), so a total-goals predicate (Over 2.5 =
  participant1 + participant2 goals `GreaterThan 2`, half-lines only) settles on the same primitive.
  The cross-market model already prices the Over/Under ladder; this would add it as a bettable,
  on-chain-settleable market and roughly double the decision rate.

## TxLINE API feedback

What worked well:

- The SSE streams delivered live World Cup data reliably; a cold start ingested 220 events in
  about 18 seconds across the two channels with no errors.
- The on-chain story is genuinely composable: `validate_stat` is a pure assertion over a
  read-only root account, so it drops cleanly into a CPI and a passing call is exactly the
  property we want (the real result matches the claim). Proof args as instruction data keep our
  account sizes constant.
- Guest auth plus the on-chain `subscribe` plus token activate is a clean, self-serve path to the
  free World Cup tier.

Friction we hit (all surmountable, noted to help the next integrator):

- The market surface per fixture was not obvious from the docs. We confirmed from a live taxonomy
  probe that each World Cup fixture carries three markets: `1X2_PARTICIPANT_RESULT`
  (`PriceNames ["part1","draw","part2"]`), `OVERUNDER_PARTICIPANT_GOALS` (`["over","under"]`, with
  the total-goals line in `MarketParameters` as `line=2.5`), and `ASIANHANDICAP_PARTICIPANT_GOALS`
  (`["part1","part2"]`, handicap in `line=...`). Full-game markets carry a null `MarketPeriod`;
  first-half markets carry `half=1`. A short table of market types, their price-name conventions,
  and the period encoding would save every integrator this probe.
- The scores channel is PascalCase (`FixtureId`, `GameState`, `Seq`, `Stats`,
  `Participant1IsHome`), while some examples implied camelCase. The mismatch cost real debugging;
  documenting the on-the-wire casing per channel would save time.
- `GameState` is null on pre-match odds records, so a strict schema must treat it as nullable,
  not merely optional.
- The single most costly surprise: on the `/api/scores/updates` (historical and replay) feed the
  textual `GameState` is frozen at "scheduled" for the entire match, including after the final
  whistle, while the real phase lives only in the numeric `StatusId` (2 H1, 3 HT, 4 H2, 5 F ended,
  10 FET, 13 FPE). Settlement that keys on the `GameState` string therefore never fires on the
  replay feed. Documenting that finality must be read from `StatusId` on `/updates` (and that the
  goal totals appear in `Stats` keys 1 and 2 well before any final string) would prevent a silent
  "nothing ever settles" failure.
- Merkle hash and root fields arrive as 32-byte integer arrays (`number[32]`) on the wire, not
  the base64 byte-strings the OpenAPI `binary` string format implies. Documenting the array
  encoding explicitly would prevent a class of encoding bugs.
- `validate_stat` is participant-indexed (stat keys 1 and 2 are participant 1 and participant 2
  goals), but the odds payload does not carry a `participant1IsHome` flag at commit time, so a
  home/away mapping cannot be sealed at commit. We keep the whole trust chain in participant
  space and treat participant-to-home as a display concern. Surfacing `participant1IsHome` on the
  odds channel (or documenting that it is scores-only) would help.
- The de-margined consensus price (`TXLineStablePriceDemargined`, booksum ~ 1) means there is no
  vig-based positive expected value; the only edge is CLV. This is reasonable, but documenting
  that the StablePrice is de-margined would set integrator expectations correctly.
- The World Cup `CompetitionId` (72) and the working host (`txline-dev.txodds.com` for both auth
  and data; an `oracle-dev` host in some notes did not resolve) were confirmed by trial.
