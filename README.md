# TxLINE autonomous odds-trading agent

![TxLINE agent operator dashboard: live feed status, the ingest to settle pipeline, and the committed and settled position ledger with on-chain Verified on Solana stamps](docs/assets/dashboard.png)

An autonomous, deterministic agent that ingests the live TxLINE World Cup feed (odds and
scores, Merkle-anchored on Solana), trades a consensus steam / divergence strategy, and keeps a
**trustless, non-cherry-picked on-chain track record**: every decision is hashed on-chain before
kickoff and settled by a CPI into TxLINE's own `txoracle::validate_stat`, so PnL is only writable
when the oracle-attested score matches the sealed claim.

Submission for the TxODDS "Trading Tools and Agents" World Cup hackathon (Superteam Earn). Devnet
and paper trading only; it places no real-money wagers.

## Why this is different

Most entries print signals. The hard problem the sponsor named is that **matches finish after the
deadline, so there is no live activity at judging time** and any claimed track record can be
cherry-picked. This agent answers that with a verifiable chain rather than a screenshot:

1. **Verified inputs.** Odds and scores are validated against TxLINE's on-chain Merkle roots.
2. **Committed decisions.** Before kickoff the agent writes `keccak256(borsh(side, fair prob,
   entry odds, stake, signal, nonce))` on-chain. Decisions cannot be backfilled or altered.
3. **Verified outcomes.** At settle, a CPI into `txoracle::validate_stat` proves the final score
   satisfies the sealed claim; the program writes PnL only if the proof passes. A bad proof, a
   wrong fixture, or a tampered stat reverts the whole settle.

The same code path runs live and in replay, so the walk-forward backtest is direct evidence about
live behaviour, not a separate script.

## Status

M0-M8 complete. **196 TypeScript tests + 9 Rust tests, all green.** The `agent_ledger` program is
deployed and the full trust chain is proven on devnet (commit before reveal, CPI-settle, and four
rejection cases: tampered root, mismatched fixture, swapped stats). A security audit
([docs/audit/M8-audit.md](docs/audit/M8-audit.md)) closed two critical settlement trust gaps,
which are fixed, deployed, and re-proven on-chain.

| Devnet artifact | Address |
| --- | --- |
| `agent_ledger` program | [`FLZiKMUaPAGMtPLbfHvHwfiVfkTZD8RZ84CSrkDy1kLD`](https://explorer.solana.com/address/FLZiKMUaPAGMtPLbfHvHwfiVfkTZD8RZ84CSrkDy1kLD?cluster=devnet) |
| TxLINE `txoracle` (CPI target) | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` |
| Strategy authority wallet | `8SafovV7444FGu3fGUJDWiqkrwsLpamsCH7buQyjKe5P` |

## Architecture

A TypeScript monorepo (pnpm + Turborepo) plus an Anchor 0.31.1 Solana program. Strict layering,
enforced by ESLint and a CI grep: `core` depends on nothing and does no IO.

```
core           pure quant + domain + decision logic (de-vig, Kelly, steam, CLV, calibration)
txline         TxLINE REST + SSE client, zod schemas, LiveSseFeed + ReplayFeed, resilience
onchain-client @solana/kit client: commit/settle, the validate_stat CPI args, account decoders
agent          composition root: LiveSseFeed -> runPipeline -> an on-chain sink; state store
api            read-only HTTP + SSE projection of the agent's state (node:http, no framework)
backtest       replay harness: CLV, calibration, drawdown, walk-forward; deterministic report
dashboard      Vite + React operator console, reads the API over HTTP/SSE only
programs/agent_ledger   the Anchor program: commit-reveal + the validate_stat CPI settle
```

Design tenets: one code path for live and replay; full determinism (injected `Clock` and seeded
PRNG, no `Date.now()` / `Math.random()` in decision code); zod at every ingress; errors as values;
money as integers (`MicroUsd = bigint`, odds x1000).

## Quickstart (for judges)

Prerequisites: Node >= 22, pnpm 11, and (for the live agent and the on-chain proof) a `.env` with
the TxLINE token and a devnet wallet; see [docs/runbooks/M6-agent.md](docs/runbooks/M6-agent.md)
and [docs/runbooks/M4-devnet.md](docs/runbooks/M4-devnet.md).

```bash
pnpm install
pnpm verify            # typecheck + 196 tests + lint + standards + core-purity, all green
```

Run the backtest on a captured World Cup window (the proof centerpiece; needs the TxLINE token):

```bash
pnpm --filter @txline-agent/devnet-tools backtest:run   # writes backtest/out/report.{md,html}
```

Run the headless agent plus the operator dashboard:

```bash
pnpm build
pnpm --filter @txline-agent/api start          # agent + read-only API (needs .env)
pnpm --filter @txline-agent/dashboard dev      # http://localhost:5173
```

Or in Docker (builds and runs the agent + API; mount the wallet read-only, pass the token):

```bash
docker build -t txline-agent .
docker run --rm -p 8080:8080 --env-file .env \
  -e AGENT_KEYPAIR_PATH=/run/keypair.json \
  -v "$HOME/.config/solana/id.json:/run/keypair.json:ro" txline-agent
```

Prove the trust chain on devnet end to end (commit -> CPI-settle -> reject a tampered proof, a
mismatched fixture, and swapped stats):

```bash
pnpm --filter @txline-agent/devnet-tools settle:e2e
```

## The strategy

TxLINE serves a single de-margined consensus price (`TXLineStablePriceDemargined`, booksum ~ 1),
so a naive Kelly +EV bet sizes to zero: the tradeable edge is **Closing Line Value**, beating the
consensus close. The agent sizes steam signals (sharp, sustained consensus moves) by move
strength, and reports CLV, calibration (Brier, log loss), hit rate, and drawdown over a
walk-forward split. The strategy is deterministic and the math is in `core` with golden tests.

Honest result from one captured window (epoch day 20629, hours 17-23): 8 settled bets, 3W/5L,
ROI +27.82% but variance-driven by long-odds upsets, mean CLV -0.0424. The deliverable is the
**methodology and the verifiable harness**, not a cherry-picked number; a single window does not
establish an edge, and the report says so.

## On-chain program

`agent_ledger` (paper trading only, no real funds). One `Strategy` ledger per agent; one
`DecisionCommit` per decision. `settle_decision` recomputes the keccak commit hash, derives the
1X2 predicate from the claim, re-derives the daily scores roots PDA, and CPIs into
`validate_stat`; it binds the proof to the committed fixture and pins the participant goal stat
keys, so a settle cannot substitute a fixture or swap stats to fabricate a result. Verification
type details and the trust model are in [docs/submission/TECHNICAL.md](docs/submission/TECHNICAL.md).

## Submission

- Demo video script: [docs/submission/DEMO-SCRIPT.md](docs/submission/DEMO-SCRIPT.md)
- Technical documentation and TxLINE API feedback: [docs/submission/TECHNICAL.md](docs/submission/TECHNICAL.md)
- Security audit: [docs/audit/M8-audit.md](docs/audit/M8-audit.md)
- Build plan and milestones: [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md)

## Security and compliance

Devnet and paper trading only; no real-money wagering. Secrets come from env, are never logged or
committed, and the `.env` and keypair files are gitignored. The repository follows a strict coding
standard and a security-audit procedure (the full audit ran at M8).
