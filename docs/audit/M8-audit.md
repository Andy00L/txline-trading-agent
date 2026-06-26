# M8 security audit and hardening report

Project: TxLINE autonomous odds-trading agent (TxODDS World Cup hackathon).
Languages: Rust (Anchor 0.31.1 program `agent_ledger`), TypeScript (pnpm monorepo).
Date: 2026-06-26. Trigger: hackathon submission preparation; the change set spans secrets, an
external feed, a payments-shaped settlement flow, and an on-chain program, so the full
REFERENCE_SECURITY_AUDIT (Phases 0-9) was run, not only the always-on rules.

## Method

Four parallel read-only audits over the trust boundaries: the on-chain program; secrets and
auth; the off-chain money path and encoding; and network/IO, the API, and the dashboard. The
on-chain program was then re-read line by line by the lead to confirm the trust findings,
which surfaced one additional CRITICAL gap (V2) the scoped pass could not see without the
off-chain settle caller. Threat model: devnet paper-trading, no real funds, but the public
on-chain record must be trustless: an authority cannot write false or cherry-picked PnL, and a
settle cannot succeed unless the oracle-attested result matches the sealed claim.

## Findings and disposition

| # | Severity | Location | Finding | Status |
| --- | --- | --- | --- | --- |
| V1 | CRITICAL | `lib.rs` settle | The proven `fixture_summary.fixture_id` was not bound to the decision's fixture; a winning proof from a different match the same UTC day could be substituted to fabricate a win. | Fixed |
| V2 | CRITICAL | `lib.rs` settle | `stat_home`/`stat_away` keys were caller-supplied and unpinned; swapping them made the `(home - away)` predicate test the winning participant regardless of the sealed side. | Fixed |
| C1 | HIGH | `score.ts` | The `participant1IsHome` flip made off-chain "home/away" mean real-home, but the odds and on-chain stat keys are participant-indexed; for `participant1IsHome=false` (knockouts) the off-chain books silently diverged from the on-chain record. | Fixed |
| A4 | LOW | `lib.rs` void | Void-window subtraction was a bare `i64 - i64` (relied on `overflow-checks` to revert with a generic panic). | Fixed (`checked_sub` + `Overflow`) |
| A5 | LOW | `lib.rs` settle/void | `open_count` decremented with `saturating_sub`, masking a corrupt invariant instead of failing loudly. | Fixed (`checked_sub`) |
| D1 | LOW | `api/server.ts` | An SSE ping write to a vanished client could surface an unhandled `'error'` and crash the process. | Fixed (`response.on('error')`) |
| D2 | LOW | `agent/runtime.ts` | The fire-and-forget `runPipeline` rejection was unobserved and could crash under `--unhandled-rejections=throw`. | Fixed (`.catch` records to the store) |
| D3 | LOW | `api/main.ts` | `runtime.stop()` could wait on a quiet SSE read, delaying SIGTERM shutdown. | Mitigated (bounded shutdown race + grace); full abort-signal plumbing noted below |
| L2 | LOW | `onchain-client/settle-args.ts` | `BigInt(number)` on a malformed non-integer wire value would throw out of an errors-as-values function. | Fixed (`Number.isSafeInteger` guard) |
| C2 | LOW | `core/pipeline.ts` | The outlier-odds breaker is inert on the single-book consensus feed (`dispersion = 0`), so it looked active but never fired. | Documented in code + here |
| L1 | LOW | `core/quant/kelly.ts`, `sizing.ts` | `Number(bankroll)` loses integer precision above ~9.007e9 USD bankroll. | Documented (bounded; realistic bankrolls are ~1e3 USD) |
| N1 | NOTE | `agent/onchain-sink.ts` | Reveal-index sealing is TOCTOU-safe in-process; two instances sharing one strategy would get a loud commit failure, not a double-commit. | No change; single-writer design |
| B3 | NOTE | `api/server.ts` | Open CORS (`*`) and no SSE subscriber cap; acceptable for public devnet read state, a scrape/DoS surface only if hosted publicly. | Documented residual risk |

## The two CRITICAL trust gaps (V1, V2)

The settle path proves that `(stat_home.value - stat_away.value)` satisfies a predicate derived
from `claimed_result`, by CPI into `txoracle::validate_stat` against the day's Merkle root. Two
inputs that decide the outcome were caller-controlled and unbound:

- V1: `fixture_summary.fixture_id` (which match the proof is about) was never required to equal
  the committed `decision.fixture_id`. The reveal was bound to the decision, but the proof was
  not, so an authority could commit a bet on fixture A, then at settle pass a valid proof for a
  different fixture B (same UTC day, same root) where the sealed side won, set
  `claimed_result = reveal.side`, and pass the CPI: a fabricated win on a decision whose real
  match lost.
- V2: even on the right fixture, `stat_home` and `stat_away` were caller-supplied. Swapping them
  (passing participant 2 as `stat_home`) makes `(stat_home - stat_away)` test the other
  participant, so for any real result the authority can pick the claim whose predicate the
  swapped difference satisfies and force `won = (claimed_result == reveal.side)` true.

Fix (in `settle_decision`, before the CPI):

```rust
require!(args.fixture_summary.fixture_id == ctx.accounts.decision.fixture_id, AgentError::FixtureMismatch);
require!(
    args.stat_home.stat_to_prove.key == STAT_KEY_PARTICIPANT1
        && args.stat_away.stat_to_prove.key == STAT_KEY_PARTICIPANT2
        && args.stat_home.stat_to_prove.period == FULL_GAME_PERIOD
        && args.stat_away.stat_to_prove.period == FULL_GAME_PERIOD,
    AgentError::StatKeyMismatch
);
```

Now the proof is pinned to the committed fixture and to participant-1-vs-participant-2 full-time
goals, so `claimed_result` is forced to the real result of the committed match. `claimed_result`
deliberately stays unbound to `reveal.side`: a true loss is settled by claiming the real result
(its predicate passes, `won = false`), which is the intended commit-reveal semantics.

## The HIGH off-chain correctness bug (C1)

The on-chain proof is participant-indexed (stat keys 1 and 2 = participant 1 and 2 goals), so the
whole trust chain is participant-space: the agent seals `reveal.side` and derives
`claimed_result` as participant 1 vs participant 2 ("home" = participant 1). The score mapper,
however, flipped `homeGoals`/`awayGoals` by `participant1IsHome`, so the off-chain pipeline result
(used by the backtest and the settled-position books) was real-home/away. For any fixture where
`participant1IsHome=false`, the off-chain books and the on-chain record disagreed (a win booked as
a loss). Fix: the score mapper no longer flips; `homeGoals` is always participant 1 goals,
matching the on-chain proof. `participant1IsHome` is retained for display only. All sampled World
Cup fixtures have `participant1IsHome=true`, so the captured data and the demo are unchanged; the
fix makes knockout legs correct. Real home/away in the trust path is impossible anyway, because
the odds payload carries no `participant1IsHome` flag at commit time.

## Verification

- On-chain unit tests: 9/9 pass, including the cross-language commit-hash and SettleArgs borsh
  goldens, which confirm the new guards did not change the byte layout.
- TypeScript: `pnpm verify` green (typecheck, 196 tests, lint, standards greps, core-purity).
- Devnet re-proof (`tools/devnet` settle-e2e, after redeploy): the honest commit -> CPI-settle
  path still succeeds; a tampered Merkle root is rejected; and two new negative cases prove the
  fixes on-chain: a settle with a mismatched `fixture_summary.fixture_id` is rejected (V1), and a
  settle with swapped home/away stats is rejected (V2).

## Documented residual items

- D3: shutdown is now bounded by an 8s grace race in `main.ts`. The fully prompt fix is to thread
  an `AbortSignal` from `LiveSseFeed.stop()` into `FetchSseConnector` so a quiet read is aborted
  at once; recommended follow-up, low urgency because TxLINE sends stream heartbeats.
- C2: the outlier-odds risk breaker requires multi-book dispersion and is inert on the single
  consensus price TxLINE serves; it is not a live control on this feed (commented at the call
  site).
- L1: stake sizing converts the bankroll bigint to a JS number; exact below ~9.007e9 USD, far
  above any realistic paper bankroll.
- B3: the read-only API uses open CORS and has no subscriber cap; fine for a single-judge devnet
  demo, but add a connection cap and tighten CORS if it is ever hosted publicly or gains a
  private field.

## Clean (verified sound, no change)

Commit-reveal binding (all 10 fields hashed, keccak recomputed at settle), borsh byte-exactness
against the Rust goldens, CPI program-pinning and roots-PDA re-derivation, checked PnL math under
`overflow-checks = true`, access control (`has_one = authority` on every instruction), monotonic
replay-proof indices, no secret logged or committed, bounded HTTP retries with timeouts and a
single 401 re-auth, race-free SSE merge with reader cleanup, idempotent backfill, no XSS
(React-escaped, `rel="noreferrer"` on the one external link), EventSource cleanup on unmount, and
no bigint reaching `JSON.stringify`.
