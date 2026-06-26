# Research: TxLINE on-chain oracle (tx-on-chain)

Captured 2026-06-25 from the `txodds/tx-on-chain` repo (IDL `idl/txoracle.json`, `types/txoracle.ts`, `backup/examples/data_validation/*.ts`). Program `txoracle` v1.4.7, Anchor 0.31.1, Apache-2.0. This is the reference for the `onchain-client` package and the `agent_ledger` CPI.

## Program IDs and mints
- Devnet program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`; TxL mint `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG` (mint corrected 2026-06-25; the prior value here was stale, see M0-recon-findings.md).
- Mainnet program `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`; TxL mint `Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL` (mint corrected 2026-06-25).

## What it is
A pure oracle for our purposes. It publishes Merkle roots (`insert_scores_root`, `insert_fixtures_root`, `insert_batch_root`) for batches over fixed UTC intervals (odds and scores every 5 minutes, fixtures daily) and verifies proofs on-chain (`validate_odds`, `validate_stat`, `validate_fixture`, `validate_fixture_batch`). Correction 2026-06-25: the mainnet IDL v1.4.7 exposes no trade or escrow instruction, but the devnet IDL v1.5.2 does expose `create_trade` and `settle_trade`. Those implement a two-party, real-SOL-staked peer wager settled by the same scores proof, which does not fit a solo paper-trading agent that proves a non-cherry-picked track record. We still own settlement through commit-reveal plus a `validate_stat` CPI. See M0-recon-findings.md finding 2.

## validate_stat (our CPI target), confirmed signature
`validate_stat(ts: i64, fixture_summary: ScoresBatchSummary, fixture_proof: Vec<ProofNode>, main_tree_proof: Vec<ProofNode>, predicate: TraderPredicate, stat_a: StatTerm, stat_b: Option<StatTerm>, op: Option<BinaryExpression>)`
- Accounts: one, `daily_scores_merkle_roots`, read-only (not writable, not signer).
- Writes no state, returns no data, reverts on failure (`PredicateFailed` 6021, `InvalidStatProof` 6023, `InvalidFixtureSubTreeProof` 6022, `InvalidMainTreeProof` 6004, `RootNotAvailable` 6007, `TimeSlotMismatch` 6005, `InvalidPda` 6009, `ProofTooLarge` 6062). Success means it did not revert.
- Calls need `ComputeBudgetProgram.setComputeUnitLimit(~10_000_000)`.

## Types (verbatim from the IDL)
- `ProofNode { hash: [u8;32], is_right_sibling: bool }`
- `ScoreStat { key: u32, value: i32, period: i32 }`
- `StatTerm { stat_to_prove: ScoreStat, event_stat_root: [u8;32], stat_proof: Vec<ProofNode> }`
- `ScoresBatchSummary { fixture_id: i64, update_stats: ScoresUpdateStats, events_sub_tree_root: [u8;32] }`
- `ScoresUpdateStats { update_count: i32, min_timestamp: i64, max_timestamp: i64 }`
- `TraderPredicate { threshold: i32, comparison: Comparison }`; `Comparison = GreaterThan | LessThan | EqualTo`
- `BinaryExpression = Add | Subtract`
- `Fixture { ts, start_time, competition, competition_id, fixture_group_id, participant1_id, participant1, participant2_id, participant2, fixture_id: i64, participant1_is_home: bool }`

## Roots PDA seeds
- Scores: `["daily_scores_roots", epoch_day as 2-byte LE]`, where `epoch_day = floor(ts_ms / 86_400_000)` (`ts` is milliseconds). IDL account name `daily_scores_merkle_roots`.
- Odds: `["daily_batch_roots", epoch_day]`.
- Fixtures: `["ten_daily_fixtures_roots", floor(epoch_day / 10) * 10]`.

## 1X2 settlement mapping (the crux)
At settle, claim a 1X2 result and pass `stat_a` = home final goals, `stat_b` = away final goals, `op = Subtract` (home minus away), with the predicate derived from the claim: Home -> `{ GreaterThan, 0 }`, Draw -> `{ EqualTo, 0 }`, Away -> `{ LessThan, 0 }`. Our `agent_ledger` derives the required predicate from the claimed result on-chain and requires `op = Subtract` and `stat_b = Some`, so a passing CPI means the real result matches the claim. Each `StatTerm` carries its own Merkle proof to the oracle root.

## Our companion program (agent_ledger), see docs/BUILD_PLAN.md
Commit-reveal: `commit_decision` stores `keccak256(borsh(RevealArgs))` before kickoff; `settle_decision` binds the reveal, pins `txline_program`, CPIs `validate_stat`, then computes PnL; `void_decision` handles voided matches with a grace window. Verification approach decided: CPI into `validate_stat` (it composes under CPI as a pure assertion over a read-only account). Proof bytes travel as settle-ix args, never stored on-chain.

## Assumptions to verify at M4 (against backup/examples and a finished fixture)

Status 2026-06-25: A-3 confirmed (statKey 1 and 2, period 0); A-5 args and discriminator confirmed (route is an M4 choice); A-7 confirmed (ms); A-4 field confirmed (`participant1_is_home`); A-8 and A-9 partial. Full resolution with sources is in M0-recon-findings.md.
- A-3 which `ScoreStat.key` plus `period` encode home vs away final goals (pull `/api/scores/stat-validation` for a finished fixture).
- A-4 if the stat is unlabeled, derive home vs away from `Fixture.participant1_is_home`.
- A-5 CPI encoding route: typed `declare_program!` vs hand-rolled `invoke` with `[discriminator(8) ++ borsh(args)]` and one read-only account.
- A-7 `ts` is milliseconds (examples divide by 86_400_000).
- A-8 a full three-stage proof plus two `StatTerm`s fits one tx (else pick a smaller-proof stat; `ProofTooLarge` 6062).
- A-9 the chosen `period` / `seq` is the final score, not an in-running snapshot.

## Sources
- https://github.com/txodds/tx-on-chain (`idl/txoracle.json`, `types/txoracle.ts`, `backup/examples/data_validation/`)
- https://www.anza.xyz/blog/solana-web3-js-2-release (Solana Kit, web3.js v2)
