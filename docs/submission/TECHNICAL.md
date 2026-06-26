# Technical documentation

TxLINE autonomous odds-trading agent. This document covers the core idea, the business and
technical highlights, the exact TxLINE endpoints used, and our feedback on the TxLINE API.

## Core idea

An autonomous, deterministic agent that trades World Cup 1X2 odds on a consensus steam /
divergence strategy, wrapped in a verifiable chain that makes its track record trustless:

1. Inputs are checked against TxLINE's on-chain Merkle roots before they influence a trade.
2. Each decision is sealed on-chain before kickoff: `commit_hash = keccak256(borsh(strategy,
   index, fixture, market, side, fair prob, entry odds, stake, signal hash, nonce))`. Only
   routing fields (fixture, market) are in the clear; side, price, and stake stay sealed.
3. At settle, the agent reveals the sealed fields and the program CPIs into
   `txoracle::validate_stat`. The 1X2 predicate is derived on-chain from the claim (home is
   `participant1 - participant2 > 0`, draw `== 0`, away `< 0`); the program writes PnL only if
   the proof passes. A bad proof, a missing root, a wrong fixture, or a swapped stat reverts the
   whole settle.

The decision logic is one code path for live and replay, so a green walk-forward backtest is
evidence about live behaviour rather than a separate simulation.

## Business highlights

- For a company whose product is verifiable on-chain sports data, this is an agent built natively
  on their trust model: it consumes the Merkle roots and settles by CPI into their own validator.
- It answers the judging problem directly. Because matches end after the deadline, a screenshot
  proves nothing; a commit-before-kickoff plus a CPI-verified settlement is a record no one can
  cherry-pick or backfill.
- The edge is measured honestly as Closing Line Value (beating the de-margined consensus close),
  the metric a professional trading desk actually tracks, with calibration and drawdown alongside.
- Production-shaped: Docker, a read-only operator API and dashboard, reconnect plus gap-backfill,
  a security audit, and devnet integration with the sponsor's program.

## Technical highlights

- Strict monorepo layering enforced by ESLint and a CI grep: `core` is pure (no IO, no clock, no
  RNG, no chain client), so the quant is unit-testable and deterministic.
- Errors as values end to end; the only `throw` is the process boundary. Money is integer
  micro-USD (`bigint`); odds are integer milli (decimal x1000). No floating point in money math.
- The commit-reveal binding is a keccak over a borsh layout that is byte-identical between the
  Rust program and the TypeScript client, pinned by a cross-language golden hash on both sides.
- `validate_stat` proof args are assembled from the three-stage scores proof and travel as
  instruction data, never stored on-chain, so account sizes are independent of proof depth.
- Resilience: SSE reconnect with exponential backoff and full jitter, one JWT re-auth on 401,
  REST gap-backfill on reconnect, and idempotency keyed by `MessageId` and `(fixtureId, seq)`.
- 196 TypeScript tests and 9 Rust tests; a security audit (docs/audit/M8-audit.md) that found and
  fixed two critical on-chain settlement trust gaps, re-proven on devnet.

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

On-chain, the agent CPIs into `txoracle::validate_stat` (devnet
`6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`) with a single read-only `daily_scores_merkle_roots`
account re-derived from the proof timestamp.

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

- The 1X2 market shape was not obvious from the docs. We confirmed from live payloads that it is
  `SuperOddsType = "1X2_PARTICIPANT_RESULT"` with `PriceNames = ["part1", "draw", "part2"]`, and
  that handicap and over/under markets reuse `part1`/`part2`, so outcome mapping must be gated on
  the market type. A short table of market types and their price-name conventions would help.
- The scores channel is PascalCase (`FixtureId`, `GameState`, `Seq`, `Stats`,
  `Participant1IsHome`), while some examples implied camelCase. The mismatch cost real debugging;
  documenting the on-the-wire casing per channel would save time.
- `GameState` is null on pre-match odds records, so a strict schema must treat it as nullable,
  not merely optional.
- Merkle hash and root fields arrive as 32-byte arrays (`number[32]`) on the wire, not the hex
  strings the OpenAPI "binary" format suggested. Calling this out explicitly would prevent a
  class of encoding bugs.
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
