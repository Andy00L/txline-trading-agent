# Research: TxLINE API surface

Captured 2026-06-25 from the live docs. This is the reference for the `txline` package schemas. Confirm the open questions (O1 to O9) against the live docs before pinning values in code.

Base URL `https://txline.txodds.com`. Headers: `Authorization: Bearer {jwt}` and `X-Api-Token: {api_token}`. Transport: SSE for live odds and scores, REST for snapshots and history. Roots publish every 5 minutes (odds, scores) and daily (fixtures). No documented rate limit or SLA; gzip supported on SSE.

## Auth
- `POST /auth/guest/start` -> `{ token }` (guest JWT, 30 days).
- `POST /api/token/activate`, body `{ txSig, walletSignature, leagues[] }` -> `{ token }` (API token). `walletSignature` is a NaCl ed25519 signature over `${txSig}:${SELECTED_LEAGUES}:${jwt}`.
- `POST /api/guest/purchase/quote`, body `{ buyerPubkey, txlineAmount }` -> a partially signed Solana tx for token purchase.

## Odds
- `GET /api/odds/stream` (SSE, live).
- `GET /api/odds/updates/{fixtureId}` (live, current 5-minute cache).
- `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}` (historical, interval 0..11 per hour).
- `GET /api/odds/snapshot/{fixtureId}?asOf={unixms}` (latest odds per market line).
- `GET /api/odds/validation?messageId={id}` (Merkle proof for a single odds update).

Odds object fields: `FixtureId` (i64), `MessageId` (string, keys the odds proof), `Ts` (i64 ms), `Bookmaker` (string), `BookmakerId` (i32), `SuperOddsType` (string), `GameState` (string, optional), `InRunning` (bool, in-play), `MarketParameters` (string, optional), `MarketPeriod` (string, optional), `PriceNames` (string[], outcome labels), `Prices` (i32[], odds values, scaling = O1), `Pct` (string[], implied probability with 3 decimals, or "NA").

## Scores
- `GET /api/scores/stream` (SSE, live).
- `GET /api/scores/updates/{fixtureId}` (current 5-minute interval).
- `GET /api/scores/historical/{fixtureId}` (all updates, 2 weeks to 6 hours past).
- `GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}` (historical interval).
- `GET /api/scores/snapshot/{fixtureId}?asOf={unixms}`.
- `GET /api/scores/stat-validation?fixtureId&seq&statKey[&statKey2]` (three-stage Merkle proof for a stat; returns the statToProve `{key,value,period}`, eventStatRoot, statProof, summary, subTreeProof, mainTreeProof).

Score object fields (soccer relevant): `fixtureId`, `gameState`, `startTime` (ms), `action`, `id`, `ts` (ms), `seq` (i32), `scoreSoccer` (SoccerFixtureScore), `statusSoccerId`, `stats` (Map<ScoreStatKey,int>), `possession`. `seq` plus `statKey` key the score proof.

## Fixtures
- `GET /api/fixtures/snapshot?startEpochDay&competitionId`.
- `GET /api/fixtures/updates/{epochDay}/{hourOfDay}`.
- `GET /api/fixtures/validation?fixtureId` (Merkle proof).
- `GET /api/fixtures/batch-validation` (hourly batch proof).

Fixture object fields: `Ts`, `StartTime` (ms), `Competition`, `CompetitionId`, `FixtureGroupId`, `Participant1Id`, `Participant1`, `Participant2Id`, `Participant2`, `FixtureId` (i64), `Participant1IsHome` (bool).

## Merkle proof shape
`ProofNode { hash (32-byte hex), isRightSibling (bool) }`; arrays run from leaf to root. Scores use a three-stage proof (stat proof, fixture sub-tree proof, main-tree proof). The exact leaf byte construction is O4 (confirm so the pure verifier matches the on-chain root).

## Open questions to confirm at M0 (do not guess)

Status 2026-06-25: O1 confirmed (Prices = decimal odds x1000), O5, O6, O7, O8, O9 confirmed; O2, O3 (numeric CompetitionId) and O4 (exact hash function) need a live capture. The full resolution log with sources, the soccer game-state enum, the stat-key table, the SSE framing, and the PDA seeds is in M0-recon-findings.md. Strategy note: free-tier odds are StablePrice de-margined consensus (likely single-book), so the steam and Closing Line Value signal on the consensus line is the primary edge; cross-book divergence activates only if more than one BookmakerId appears.
- O1 `Prices` integer scaling (x1000 assumed) and whether only decimal odds appear.
- O2 exact 1X2 `PriceNames` labels and order, and how `MarketPeriod` / `MarketParameters` mark full-time.
- O3 World Cup `CompetitionId` and `competition` string.
- O4 odds and score Merkle leaf byte construction.
- O5 how a 5-minute root window is addressed on chain.
- O6 odds and fixtures ordering for gap detection.
- O7 SSE event names and whether `Last-Event-ID` resume exists.
- O8 confirm no rate limit or SLA.
- O9 which `gameState` / `statusSoccerId` marks a final settled result and a void.

## Sources
- https://txline-docs.txodds.com/llms.txt and the `llms-full.txt` variant
- https://txline-docs.txodds.com/api-reference/odds , /scores , /fixtures , /authentication
- https://txline-docs.txodds.com/documentation/quickstart and /documentation/worldcup
