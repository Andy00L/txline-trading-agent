# Demo video script (5 minutes)

A timed walkthrough for the submission video (Loom or YouTube, up to 5:00). It covers the
problem, a live app walkthrough, and how TxLINE powers the backend. `[SHOW]` is what is on
screen; `[SAY]` is the narration. Keep narration at a calm pace; the script is sized to fit 5:00.

## Pre-record checklist

- `.env` configured (TxLINE token + devnet wallet); `pnpm install && pnpm build` done.
- The seeded or live dashboard running at `http://localhost:5173` with a few committed and one
  settled position visible (run the agent during a window, or use the API with recorded state).
- Group-stage backtest report generated: `pnpm --filter @txline-agent/devnet-tools backtest:sweep`
  (or `backtest:run` for a single window), open `backtest/out/report.html`.
- Solana Explorer (devnet) open on the program:
  `https://explorer.solana.com/address/FLZiKMUaPAGMtPLbfHvHwfiVfkTZD8RZ84CSrkDy1kLD?cluster=devnet`,
  with one `DecisionSettled` transaction open in another tab (expand the inner instructions to
  show the CPI into `txoracle`).
- A terminal ready to run `pnpm --filter @txline-agent/devnet-tools settle:e2e`.

## 0:00 to 0:30  The problem

[SHOW] Title card, then the sponsor brief line about matches finishing after the deadline.
[SAY] "TxLINE publishes World Cup odds and scores, Merkle-anchored on Solana. The hackathon's own
problem is that matches finish after the deadline, so at judging time there is no live activity,
and any track record an agent claims could be cherry-picked. So I built an autonomous agent whose
record is trustless: every decision is committed on-chain before kickoff and settled by a proof
into TxLINE's own oracle."

## 0:30 to 1:15  Live ingestion, powered by TxLINE

[SHOW] The dashboard: the feed-status pill `connected`, the events counter rising, the
ingest-to-settle pipeline lighting up.
[SAY] "The agent opens the TxLINE odds and scores SSE streams and ingests them live. On a cold
start it pulls a couple of hundred events in seconds. The strategy is cross-market relative value:
TxLINE serves a full surface per fixture, the 1X2 market plus an Over/Under total-goals ladder plus
an Asian-Handicap ladder, and the agent fits one goals model to all of them at once. It backs the
1X2 leg the joint fit prices longer than the 1X2 line implies, the lagging market that has not
caught up yet. TxLINE serves a de-margined consensus, so the edge is not vig, it is Closing Line
Value, getting on before the line moves to the close."

## 1:15 to 2:15  Commit before kickoff

[SHOW] A committed position card (sealed: fixture, side, stake, entry odds, fair probability),
then click through to its commit transaction on Solana Explorer.
[SAY] "When a signal clears risk, the agent seals the decision and writes a keccak hash of the
side, fair probability, entry odds, stake, and a nonce on-chain, before kickoff. Only the fixture
and market are in the clear. Here is the commit transaction on devnet. Notice the commit slot is
before the match start. The decision cannot be backfilled or altered after this point."

## 2:15 to 3:15  Settlement verified by CPI into validate_stat

[SHOW] The same position flipped to settled, with the green "Verified on Solana" stamp, the PnL,
and the CLV. Then the settle transaction on Explorer, inner instructions expanded to show the CPI
into the `txoracle` program.
[SAY] "After the final whistle, the agent reveals the sealed fields and settles. The program
recomputes the hash, derives the 1X2 predicate from the claim, and makes a cross-program call into
TxLINE's own `validate_stat` with the score's Merkle proof. You can see the inner instruction here,
the call into the oracle. The program writes profit and loss only because that proof passed. If the
proof were bad, the settle would revert and nothing would be written."

## 3:15 to 3:55  Why the record is trustless

[SHOW] Terminal running `pnpm --filter @txline-agent/devnet-tools settle:e2e`, scrolling to the
four rejection lines.
[SAY] "This end-to-end check proves the guarantees on the live devnet program. An honest settle
succeeds. A tampered Merkle proof is rejected. A proof for a different match is rejected. And
swapped home and away stats are rejected. Those last two were gaps a security audit caught and I
fixed, so the operator cannot fabricate a win by substituting a fixture or flipping the stats. The
record is only what the oracle attests."

## 3:55 to 4:35  The walk-forward backtest

[SHOW] `backtest/out/report.html`: the equity curve, the Closing Line Value, the calibration
diagram.
[SAY] "The same decision code that runs live also runs the backtest, so a green backtest is
evidence about live behaviour, not a separate simulation. The report measures Closing Line Value
with a bootstrap confidence interval, plus calibration, hit rate, and drawdown, aggregated across
the group stage. I am reporting it honestly: the edge is cross-market timing on a de-margined
consensus, the test is whether the line moves to my entry by the pre-kickoff close, and I show the
interval rather than a single cherry-picked number. The deliverable is the verifiable methodology
and the trustless record."

## 4:35 to 5:00  Close

[SHOW] The architecture diagram or the repo README.
[SAY] "Under the hood: a pure deterministic quant core, a resilient TxLINE client, an Anchor
program for commit and settle, a headless agent with a read-only API, and this dashboard. Strict
typing, errors as values, money as integers, 307 tests, and a security audit. Devnet and paper
trading only. Everything is open source. Thanks for watching."

## Notes for editing

- If a live match is available during recording, show a real commit landing before kickoff; if
  not, the recorded devnet transactions plus the settle-e2e run carry the proof.
- Keep the Explorer inner-instruction view on screen long enough to read "txoracle"; it is the
  single most important frame for the innovation criterion.
