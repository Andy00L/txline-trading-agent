# M0 recon findings: open-question resolution log

Captured 2026-06-25 from the live TxLINE docs (`txline-docs.txodds.com`), the OpenAPI spec (`/api-reference/openapi.json`, API version 1.5.2), and the public `txodds/tx-on-chain` repository (IDL `idl/txoracle.json` mainnet v1.4.7, the devnet IDL embedded in `documentation/programs/devnet.md` v1.5.2, `types/txoracle.ts`, and `backup/examples/`). This document is the source of record for the open questions O1 to O9 and A-3 to A-9. Where a value is marked CONFIRMED it has a cited source; where it is marked CAPTURE it needs a live payload (and therefore the subscription token) before it is pinned in code.

## Toolchain state (WSL Ubuntu 24.04)

- Node v22.22.2, npm 10.9.7, pnpm 11.9.0 (activated through corepack into `~/.local/bin`), Rust 1.94.1, Solana CLI 3.1.9 (Agave), gh 2.89.0 (authenticated).
- anchor-cli 1.0.0 is installed; the project targets Anchor 0.31.1 to match the txoracle repo. This affects M4 only (the on-chain program). Resolution: install Anchor 0.31.1 through `avm` before M4. Off-chain milestones M0 to M3 do not need Anchor.

## API and on-chain identity (corrections to prior research docs)

The mint addresses in `docs/research/txline-onchain.md` are stale. The authoritative values from the live program-addresses page and the IDL `constants` are:

| Item | Value | Source |
| --- | --- | --- |
| Devnet program id | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` | programs/addresses, devnet IDL `address` |
| Mainnet program id | `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` | programs/addresses, mainnet IDL `address` |
| Devnet TxL mint | `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` | programs/addresses (devnet), devnet IDL `TXLINE_MINT` |
| Mainnet TxL mint | `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` | programs/addresses (mainnet), mainnet IDL `TXLINE_MINT` |
| Devnet USDT mint | `ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh` | programs/addresses (devnet) |
| Mainnet USDT mint | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | programs/addresses (mainnet), IDL `USDT_MINT` |
| Off-chain API version | 1.5.2 | OpenAPI `info.version` |
| Devnet on-chain IDL version | 1.5.2 | devnet IDL `metadata.version` |
| Mainnet on-chain IDL version | 1.4.7 | mainnet IDL `metadata.version` |

Hostnames: data base URL is `https://txline.txodds.com` (mainnet) and `https://txline-dev.txodds.com` (devnet). Auth in the repo examples uses `https://oracle.txodds.com` and `https://oracle-dev.txodds.com`; the two host families appear interchangeable for the documented calls. The client base URL must be configurable per cluster.

`TOKEN_DECIMALS = 6` (IDL constant). The TxL token is Token-2022 (`TOKEN_2022_PROGRAM_ID` in every subscribe example). Rate: 1 USDT = 1000 TxL (IDL `TOKEN_PRICE_IN_USDT`, and the API overview).

## API open questions

| Q | Status | Resolution | Source |
| --- | --- | --- | --- |
| O1 Prices scaling | CONFIRMED | `Prices[i]` is decimal odds multiplied by 1000 (three-decimal precision). Example in repo: `odds: 2000 // 2.0 decimal odds`. So `DecimalOddsMilli = round(decimalOdds * 1000)`. | tx-on-chain README line 934, trade-offer example line 928 |
| O2 1X2 PriceNames labels and order, full-time marker | CAPTURE | `OddsPayload.PriceNames: string[]` with parallel `Prices: int32[]` and `Pct: string[]`. The exact labels (for example `1` / `X` / `2` versus `Home` / `Draw` / `Away`) and how `MarketPeriod` / `MarketParameters` mark full-time 1X2 are not in the text and need one real odds payload. Design: outcome mapping is config-driven from `PriceNames`. | OpenAPI `OddsPayload` schema |
| O3 World Cup competition id | PARTIAL | `competitionId: 500005` in the docs means NCAA Division I FBS, not the World Cup. World Cup access is by service level 1 (60s delay) or 12 (real-time) with an empty leagues array; fixtures carry `Competition` / `FixtureGroupId` tagged "World Cup > Group Stage". The numeric `CompetitionId` for World Cup soccer needs a real fixtures snapshot. Not blocking: filter on the `Competition` string or the published fixture-id list below. | worldcup, odds-coverage line 27, scores/schedule |
| O4 Merkle leaf and node hashing | PARTIAL | Three-stage hierarchy confirmed (stat sub-tree, fixture event sub-tree, main batch tree), roots over 5-minute UTC-aligned intervals, published on-chain. The exact leaf serialization and the parent hash function (keccak256 vs sha256, sibling order by `isRightSibling`) are not in public text. The on-chain `validate_stat` performs the real check under CPI, so the pure off-chain `verifyProof` is a secondary risk-breaker; pin its hash function by matching one real proof against the on-chain root at M2 or M4. | scores stat-validation page, README lines 37 to 39 |
| O5 5-minute root window addressing | CONFIRMED | One daily PDA per channel holds the day's roots; the specific 5-minute batch is matched internally by the summary `min_timestamp` / `max_timestamp` (error `TimeSlotMismatch` 6005). Scores seed `daily_scores_roots`, odds `daily_batch_roots`, fixtures `ten_daily_fixtures_roots`, each plus a 2-byte little-endian u16 epoch day; fixtures align to `floor(epochDay/10)*10`. | programs/addresses, validate example, onchain-validation |
| O6 odds and fixtures ordering for gap detection | CONFIRMED | Odds SSE event `id` is `"{Ts}:{index}"`, which is the ordering key; gaps are detected on the `(Ts, index)` sequence. Scores carry an integer `seq` per fixture. Fixtures are daily batches. | OpenAPI odds-stream description |
| O7 SSE event names and resume | CONFIRMED | Two event kinds: data messages with `id = "{timestamp}:{index}"` and `data` = one record JSON; heartbeats with `event: "heartbeat"` and data such as `{"Ts": 12345}`. The `Last-Event-ID` request header is supported to resume. | OpenAPI odds-stream and scores-stream |
| O8 rate limit and SLA | CONFIRMED | No rate limit on the free tier. Free data is 60s delayed (service level 1) or real-time (service level 12). Still implement conservative backoff for resilience. | worldcup FAQ |
| O9 final and void game states | CONFIRMED | Soccer game phase ids: 1 NS, 2 H1, 3 HT, 4 H2, 5 F (ended), 6 WET, 7 ET1, 8 HTET, 9 ET2, 10 FET (ended after extra time), 11 WPE, 12 PE, 13 FPE (ended after penalties), 14 I (interrupted), 15 A (abandoned), 16 C (cancelled), 17 TXCC, 18 TXCS, 19 P (postponed). Settle when state is in {5, 10, 13}; void when state is in {14, 15, 16, 17, 18, 19}. | soccer-feed game phase table |

Additional API facts:

- Auth: `POST /auth/guest/start` returns a 30-day guest JWT. Activate with `POST /api/token/activate` body `{ txSig, walletSignature, leagues[] }`; `walletSignature` is a NaCl ed25519 detached signature over the exact string `` `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}` `` (note the comma join and the inclusion of the JWT), base64 encoded. On HTTP 401 reacquire the JWT once and retry.
- OddsPayload required fields: `FixtureId i64`, `MessageId string`, `Ts i64 ms`, `Bookmaker string`, `BookmakerId i32`, `SuperOddsType string`, `InRunning bool`. Optional: `GameState string`, `MarketParameters string`, `MarketPeriod string`, `PriceNames string[]`, `Prices i32[]`, `Pct string[]`. `Pct[i]` is the implied probability as a percentage string with three decimals (regex `^(NA|\d+\.\d{3})$`, example `52.632`), or `NA` for quarter-handicap lines. `MessageId` keys the odds Merkle proof.
- Free-tier odds are StablePrice, de-margined consensus prices ("effectively, probabilities") for the main markets. See the strategy note below.

## On-chain open questions

| Q | Status | Resolution | Source |
| --- | --- | --- | --- |
| A-3 stat keys for home and away goals | CONFIRMED | Stat key formula `(period * 1000) + base_key`. Base keys: 1 = Participant 1 total goals, 2 = Participant 2 total goals, 3/4 yellow cards, 5/6 red cards, 7/8 corners. Full-time totals use base keys 1 and 2 at period 0. The repo's own validate example queries `statKey=1, statKey2=2` and the trade example sets `statA: { key: 1 } // Participant1_Score`. | soccer-feed stat encoding, validate_scores_onchain.ts, README trade example |
| A-4 home vs away assignment | CONFIRMED (field) | The `Fixture` type has `participant1_is_home: bool`. Participant 1 maps to home when true. Confirm the value per fixture from a real fixtures record. | mainnet and devnet IDL `Fixture` type |
| A-5 CPI encoding route and args | CONFIRMED (args), CHOICE (route) | `validate_stat` discriminator `[107,197,232,90,191,136,105,185]`; args in order: `ts i64`, `fixture_summary ScoresBatchSummary`, `fixture_proof Vec<ProofNode>`, `main_tree_proof Vec<ProofNode>`, `predicate TraderPredicate`, `stat_a StatTerm`, `stat_b Option<StatTerm>`, `op Option<BinaryExpression>`; one account `daily_scores_merkle_roots` (read-only, not signer). Anchor discriminators are derived from the instruction name, so this is stable across IDL versions. Route (typed `declare_program!` vs hand-rolled `invoke` of `[discriminator ++ borsh(args)]`) is an M4 implementation choice. | IDL `validate_stat`, onchain-validation example |
| A-7 ts units | CONFIRMED | `ts` is milliseconds. Every example computes `epochDay = Math.floor(ts / (24*60*60*1000))` and seeds the PDA with the 2-byte LE epoch day. | onchain-validation, validate_scores_onchain.ts |
| A-8 proof and compute fit | PARTIAL | The real `validate_stat` `.rpc()` in the repo sets `setComputeUnitLimit({ units: 10_000_000 })` and runs a two-stat validation in one transaction, so the three-stage proof plus two `StatTerm`s fits a standalone call. Under CPI from `agent_ledger` the combined compute must be re-measured on devnet (Agave 3.1.9), and `ProofTooLarge` (6062) bounds proof depth. Measure at M4. | validate_scores_onchain.ts lines 208 to 213 |
| A-9 final score vs in-running | CONFIRMED (with nuance) | Period-0 base keys 1 and 2 are cumulative totals. For group-stage matches (no extra time) the period-0 total equals the 90-minute result, so settle when game state is 5 (F). For knockout matches that reach extra time or penalties, the full-time 1X2 result is the 90-minute score, which is H1 + H2 only; revisit the knockout case before the knockout rounds. The hackathon window and the backtest are group stage, so period-0 totals are correct for the primary scope. | soccer-feed period encoding |

On-chain types verbatim from the IDL (mirror these exactly in `agent_ledger`'s `txline_cpi.rs`):

- `ScoreStat { key: u32, value: i32, period: i32 }` (note: off-chain JSON types `key` as i32; widen to u32 at the chain boundary)
- `StatTerm { stat_to_prove: ScoreStat, event_stat_root: [u8;32], stat_proof: Vec<ProofNode> }`
- `ScoresBatchSummary { fixture_id: i64, update_stats: ScoresUpdateStats, events_sub_tree_root: [u8;32] }` (off-chain JSON types `fixtureId` as i32 and names the root `eventStatsSubTreeRoot`; widen to i64 and remap the field name)
- `ScoresUpdateStats { update_count: i32, min_timestamp: i64, max_timestamp: i64 }`
- `ProofNode { hash: [u8;32], is_right_sibling: bool }`
- `TraderPredicate { threshold: i32, comparison: Comparison }`
- `Comparison` enum: GreaterThan (0), LessThan (1), EqualTo (2)
- `BinaryExpression` enum: Add (0), Subtract (1)

## 1X2 full-time settlement mapping (the crux, now fully grounded)

At settle, pass `stat_a` = Participant 1 total goals (statKey 1, period 0), `stat_b` = Participant 2 total goals (statKey 2, period 0), `op = Subtract` (home minus away). Derive the predicate from the committed claim on-chain:

- Home win: `home - away > 0` -> `{ comparison: GreaterThan, threshold: 0 }`
- Draw: `home - away == 0` -> `{ comparison: EqualTo, threshold: 0 }`
- Away win: `home - away < 0` -> `{ comparison: LessThan, threshold: 0 }`

`agent_ledger.settle_decision` derives the required predicate from the claimed result, requires `op == Subtract` and `stat_b.is_some()`, then CPIs `validate_stat`. A passing CPI proves the oracle-attested score satisfies the claim. Each `StatTerm` carries its own `stat_proof`; both stats in one update share the same `event_stat_root` (confirmed: stat2 reuses `validation.eventStatRoot`). Fetch the proof args from `GET /api/scores/stat-validation?fixtureId&seq&statKey=1&statKey2=2`.

## Two findings worth a decision entry

1. Free-tier odds are consensus-only (StablePrice). The free World Cup tier serves de-margined StablePrice consensus odds, not a fan of individual bookmaker lines. The cross-sectional consensus-divergence signal (one book vs the consensus) needs multi-book data that the free tier likely does not carry. The time-series half of the locked archetype (sharp-move / steam detection on the consensus line, measured by Closing Line Value and calibration) is fully available on consensus-only data and becomes the primary signal. The decision archetype is unchanged; the emphasis shifts. Confirm multi-book availability at capture. Design `core` so cross-book divergence is an enhancement that activates only when more than one `BookmakerId` is present for a market.

2. Devnet IDL 1.5.2 exposes `create_trade` and `settle_trade`. These implement a two-party, real-SOL-staked peer wager that settles through the same `/api/scores/stat-validation` proof. It is not a fit for a solo, paper-only agent proving a non-cherry-picked track record: it requires a counterparty and real value. We still own settlement through commit-reveal plus a `validate_stat` CPI, which gives a self-contained trustless record without a counterparty or real funds. This strengthens, rather than weakens, the trust-model decision and answers the obvious judge question ("why not use `settle_trade`?").

## World Cup group-stage fixtures (backtest replay universe)

From the live schedule page, all soccer, group `World Cup > Group Stage`, times UTC. Use these fixture ids as the replay and demo target set. The numeric `CompetitionId` is to be read from a real fixtures snapshot at capture.

```
17588227  2026-06-11 19:00  Mexico v South Africa
17926696  2026-06-12 02:00  South Korea v Czech Republic
17926604  2026-06-12 19:00  Canada v Bosnia & Herzegovina
17588396  2026-06-13 01:00  USA v Paraguay
17588308  2026-06-13 19:00  Qatar v Switzerland
17588386  2026-06-13 22:00  Brazil v Morocco
17588316  2026-06-14 01:00  Haiti v Scotland
17926689  2026-06-14 04:00  Australia v Turkey
17588318  2026-06-14 17:00  Germany v Curacao
17588305  2026-06-14 20:00  Netherlands v Japan
17588239  2026-06-14 23:00  Ivory Coast v Ecuador
17926553  2026-06-15 02:00  Sweden v Tunisia
17588403  2026-06-15 16:00  Spain v Cape Verde
17588230  2026-06-15 19:00  Belgium v Egypt
17588311  2026-06-15 22:00  Saudi Arabia v Uruguay
17588241  2026-06-16 01:00  Iran v New Zealand
17588306  2026-06-16 19:00  France v Senegal
17926828  2026-06-16 22:00  Iraq v Norway
17588322  2026-06-17 01:00  Argentina v Algeria
17588405  2026-06-17 04:00  Austria v Jordan
17926703  2026-06-17 17:00  Portugal v Congo DR
17588228  2026-06-17 20:00  England v Croatia
17588406  2026-06-17 23:00  Ghana v Panama
17588399  2026-06-18 02:00  Uzbekistan v Colombia
17926765  2026-06-18 16:00  Czech Republic v South Africa
17926603  2026-06-18 19:00  Switzerland v Bosnia & Herzegovina
17588238  2026-06-18 22:00  Canada v Qatar
17588223  2026-06-19 01:00  Mexico v South Korea
17588388  2026-06-19 19:00  USA v Australia
17588397  2026-06-19 22:00  Scotland v Morocco
17588317  2026-06-20 00:30  Brazil v Haiti
17588229  2026-06-20 03:00  Turkey v Paraguay
17926687  2026-06-20 17:00  Netherlands v Sweden
17588240  2026-06-20 20:00  Germany v Ivory Coast
17588320  2026-06-20 23:00  Ecuador v Curacao
17588310  2026-06-21 04:00  Tunisia v Japan
17588232  2026-06-21 16:00  Spain v Saudi Arabia
17588390  2026-06-21 19:00  Belgium v Iran
17588235  2026-06-21 22:00  Uruguay v Cape Verde
17588242  2026-06-22 01:00  New Zealand v Egypt
17588389  2026-06-22 17:00  Argentina v Austria
17926647  2026-06-22 21:00  France v Iraq
17588313  2026-06-23 00:00  Norway v Senegal
17588244  2026-06-23 03:00  Jordan v Algeria
17588231  2026-06-23 17:00  Portugal v Uzbekistan
17588324  2026-06-23 20:00  England v Ghana
17588401  2026-06-23 23:00  Panama v Croatia
17926615  2026-06-24 02:00  Colombia v Congo DR
17588303  2026-06-24 19:00  Switzerland v Canada
17926766  2026-06-24 19:00  Bosnia & Herzegovina v Qatar
17588319  2026-06-24 22:00  Morocco v Haiti
17588398  2026-06-24 22:00  Scotland v Brazil
17588395  2026-06-25 01:00  South Africa v South Korea
17926764  2026-06-25 01:00  Czech Republic v Mexico
17588302  2026-06-25 20:00  Ecuador v Germany
17588321  2026-06-25 20:00  Curacao v Ivory Coast
17588236  2026-06-25 23:00  Tunisia v Netherlands
17926686  2026-06-25 23:00  Japan v Sweden
17926593  2026-06-26 02:00  Turkey v USA
17588234  2026-06-26 19:00  Norway v France
17926740  2026-06-26 19:00  Senegal v Iraq
17588314  2026-06-27 00:00  Cape Verde v Saudi Arabia
17588404  2026-06-27 00:00  Uruguay v Spain
17588309  2026-06-27 03:00  Egypt v Iran
17588323  2026-06-27 03:00  New Zealand v Belgium
17588245  2026-06-27 21:00  Croatia v Ghana
17588402  2026-06-27 21:00  Panama v England
17588391  2026-06-27 23:30  Colombia v Portugal
17926704  2026-06-27 23:30  Congo DR v Uzbekistan
17588325  2026-06-28 02:00  Jordan v Argentina
17588326  2026-06-28 02:00  Algeria v Austria
```

A known historical sample for shape and proof testing (from the repo examples, not a guaranteed final fixture): `fixtureId 17271370, seq 401`. A docs sample for scores snapshot shape: `fixtureId 17952170, seq 941`.

## Still open, needs the subscription token (blocks live capture only, not the build)

- O2 exact 1X2 PriceNames labels and order, and the full-time `MarketPeriod` / `MarketParameters` values.
- O3 numeric World Cup CompetitionId.
- O4 the exact leaf and node hash function for the pure verifier.
- Free-tier multi-book availability (strategy note 1).
- A captured fixture window (odds, scores, fixtures, proofs) for golden tests.

Until the token is provided, code is written against the schemas above, every empirical unknown is isolated behind a single named constant or a config table with a `CAPTURE` comment, and the captured-fixture golden tests are stubbed with synthetic but schema-valid payloads.

## Sources

- Live docs: `txline-docs.txodds.com` (odds-stream, scores-stream, scores stat-validation, onchain-validation example, worldcup, programs/addresses, programs/devnet, soccer-feed, scores/schedule, subscription-tiers, authentication pages), and the OpenAPI at `/api-reference/openapi.json` (version 1.5.2).
- On-chain: `github.com/txodds/tx-on-chain` (`idl/txoracle.json` v1.4.7, the devnet IDL in `documentation/programs/devnet.md` v1.5.2, `types/txoracle.ts`, `backup/examples/data_validation/validate_scores_onchain.ts`, `backup/examples/snapshots/*`, `backup/examples/streaming/*`, `README.md`).
