# BRIEF: TxLINE autonomous odds-trading agent

## Goal
Win 1st place in the TxODDS "Trading Tools and Agents" World Cup hackathon track (Superteam Earn). Build a running, autonomous, deterministic agent that ingests the live TxLINE feed (World Cup odds and scores, Merkle-anchored on Solana) and trades a consensus-divergence strategy, with a trustless on-chain track record. Winning means the judges (TxODDS quants) see an agent they could deploy: defensible math, verified data, and a record that cannot be cherry-picked.

## Deliverables
- Public GitHub repo (this repo).
- Demo video, up to 5 minutes (Loom or YouTube): the problem, an autonomous run, a commit-before-kickoff and a CPI-verified settlement, and the walk-forward backtest report.
- Working judge access: a hosted dashboard plus a devnet program and endpoint to test.
- Technical doc: core idea, the exact TxLINE endpoints used, and the API feedback answer.

## Deadline and milestones
- Submissions close 2026-07-19 23:59 UTC. Winners 2026-07-29.
- M0 recon and docs, M1 quant core, M2 feed layer, M3 strategy and risk, M4 on-chain commit/settle, M5 backtest report, M6 agent service and API, M7 dashboard, M8 security audit, M9 submission. Detail in `BUILD_PLAN.md`.

## Judging criteria (sponsor)
Data ingestion, autonomous operation, deterministic and defensible logic, innovation and novelty, production readiness. Heavy weight on the demo video, because matches finish after the deadline so there is no live activity at judging time.

## Constraints
- Must integrate TxLINE as a live input. SSE for live, REST for snapshots and history.
- Devnet and paper trading only. No real-money betting (legal note in `requirements.md`).
- The agent never runs git; the human commits and ships.
- The coding standards and security-audit rules are the floor; the stricter rule wins.

## Stack
- TS monorepo: pnpm plus Turborepo. Packages core (pure), txline, onchain-client, agent, backtest, api, dashboard.
- Solana: @solana/kit (web3.js v2); Anchor 0.31.1 program agent_ledger; CPI into TxLINE txoracle validate_stat for trustless outcome verification.
- Dashboard: Vite plus React, reusing the design tokens under `.claude/design-handoff`.

## Demo script (what the judge sees)
1. The agent running unattended on a replayed World Cup fixture window: odds in, fair value, divergence signal, sized order.
2. A decision committed on-chain before kickoff (Solana Explorer devnet link; commit slot before start time).
3. After the final whistle, settlement by CPI into TxLINE validate_stat; PnL written only because the oracle-attested score matched the claim.
4. The walk-forward backtest report: Closing Line Value, calibration, drawdown.

## Out of scope
- In-play market making and agent-vs-agent (rejected archetypes).
- Mainnet, real funds, fiat, or any wagering with value.
- Sports other than World Cup soccer; markets beyond 1X2 full-time (Over/Under 2.5 is a stretch extension only).
