# M6 runbook: the headless agent service plus API

The agent ingests the live TxLINE odds and scores streams, runs the deterministic decision
pipeline, commits each decision on-chain before kickoff, and settles by CPI into
`validate_stat` after the final whistle. A read-only HTTP/SSE API projects its state. One
process (`@txline-agent/api`) boots the runtime and serves the API.

## What it does

- `FetchSseConnector` opens `/api/odds/stream` and `/api/scores/stream`, merges them, and
  feeds `LiveSseFeed` (reconnect with backoff plus REST gap-backfill).
- `runPipeline` (the same code the backtest runs) de-vigs, detects steam/divergence, sizes
  CLV-first, and commits at most one decision per market. It settles a fixture's open
  positions the moment a final-whistle score (`F`/`FET`/`FPE`) arrives. sourceRef:
  `packages/core/src/domain/score-state.ts` (O9).
- `OnChainSink` seals each decision into a `RevealArgs` at the live on-chain index, commits
  the hash, and on settle fetches the stat-validation proof for that exact score `seq` and
  settles by CPI. Failures are recorded in the state store, never thrown.
- The API exposes `GET /health`, `GET /api/state` (the snapshot), and `GET /api/events` (SSE).

## Configuration (environment)

Required (same `.env` as the M4 devnet runbook plus the TxLINE token):

| Variable | Meaning |
| --- | --- |
| `SOLANA_RPC_URL` | devnet RPC endpoint |
| `AGENT_KEYPAIR_PATH` | path to the authority keypair JSON (mounted read-only in Docker) |
| `TXORACLE_PROGRAM_ID` | devnet txoracle program id |
| `TXLINE_DATA_BASE_URL`, `TXLINE_AUTH_BASE_URL` | `https://txline-dev.txodds.com` for both |
| `TXLINE_JWT`, `TXLINE_API_TOKEN` | the free World Cup tier credentials |

Optional (sane defaults match the validated backtest config): `API_PORT` (8080),
`STARTING_BANKROLL` (1_000_000_000 micro-USD), `STEAM_WINDOW_MS`, `STEAM_MIN_PROB_MOVE`,
`STEAM_BASE_FRACTION`, `STEAM_STRENGTH_SCALE`, `STEAM_MAX_FRACTION`, `STEAM_HISTORY_LIMIT`,
`MAX_STAKE_MICRO_USD`, `MAX_CONCURRENT`, `STALE_FEED_MS`, `AGENT_MAX_RECONNECTS`
(0 = unbounded).

## Run locally

```bash
pnpm build
pnpm --filter @txline-agent/api start          # reads ../../.env, serves on API_PORT
curl http://localhost:8080/health              # {"status":"ok"}
curl http://localhost:8080/api/state           # the live snapshot
curl -N http://localhost:8080/api/events       # SSE: snapshot on every change
```

If the required env is missing the process prints which variable is missing and exits 1.

## Run in Docker

```bash
docker build -t txline-agent .
docker run --rm -p 8080:8080 \
  --env-file .env \
  -e AGENT_KEYPAIR_PATH=/run/keypair.json \
  -v "$HOME/.config/solana/id.json:/run/keypair.json:ro" \
  txline-agent
```

The image bakes in no secrets: the token comes from `--env-file` and the wallet is mounted
read-only. The container `HEALTHCHECK` polls `/health`.

## Verify

- `pnpm --filter @txline-agent/agent test` and `pnpm --filter @txline-agent/api test` cover
  the reveal mapping, the on-chain sink (commit, index translation, proof-fetch settle, error
  paths), the state projection, the feed tap, and the HTTP routes.
- Against live data: start the process during a World Cup window, watch `commitsCount` rise in
  `/api/state` before kickoff and the `DecisionCommitted` transactions on Solana Explorer
  (devnet); after the final whistle, watch settlements appear with their `validate_stat` tx.
