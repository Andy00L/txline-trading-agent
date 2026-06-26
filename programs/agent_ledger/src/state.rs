use anchor_lang::prelude::*;

use crate::txline_cpi::{ProofNode, ScoresBatchSummary, StatTerm};

// Decision lifecycle.
pub const STATUS_OPEN: u8 = 0;
pub const STATUS_SETTLED: u8 = 1;
pub const STATUS_VOID: u8 = 2;

// 1X2 result sides, matching the off-chain Outcome ordering (home, draw, away).
pub const SIDE_HOME: u8 = 0;
pub const SIDE_DRAW: u8 = 1;
pub const SIDE_AWAY: u8 = 2;

// A void is only allowed within this window after commit, so it cannot dodge an
// imminent loss late in a match. It is wide enough to cover a pre-kickoff
// postponement (commit happens before kickoff). sourceRef: docs/BUILD_PLAN.md.
pub const VOID_GRACE_SECONDS: i64 = 21_600; // 6 hours

pub const STRATEGY_SEED: &[u8] = b"strategy";
pub const COMMIT_SEED: &[u8] = b"commit";

/// One trading strategy's ledger and rolling accounting.
#[account]
#[derive(InitSpace)]
pub struct Strategy {
    pub authority: Pubkey,
    pub strategy_id: u64,
    /// Pinned CPI target; settle reverts if a different program is passed (anti-swap).
    pub txline_program: Pubkey,
    pub starting_bankroll: u64,
    pub bankroll: u64,
    pub realized_pnl: i64,
    pub decisions_count: u64,
    pub open_count: u64,
    pub settled_count: u64,
    pub wins: u32,
    pub losses: u32,
    pub pushes: u32,
    /// Rolling accumulator folded on every commit; binds the full commit history.
    pub commit_log_root: [u8; 32],
    pub bump: u8,
}

/// One committed decision. In the clear: only the routing fields (fixture, market)
/// and the lifecycle. The side, fair probability, entry odds, stake, signal, and
/// nonce stay sealed inside commit_hash until reveal at settle.
#[account]
#[derive(InitSpace)]
pub struct DecisionCommit {
    pub strategy: Pubkey,
    pub index: u64,
    pub commit_hash: [u8; 32],
    pub fixture_id: i64,
    pub market: u16,
    pub commit_slot: u64,
    pub commit_unix_ts: i64,
    pub status: u8,
    pub outcome_side: u8,
    pub pnl: i64,
    pub settle_slot: u64,
    pub bump: u8,
}

/// The sealed decision fields. commit_hash = keccak256(borsh(RevealArgs)); at settle
/// the agent submits these verbatim and the program recomputes the hash, so the
/// side, price, and stake are immutable after commit.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RevealArgs {
    pub strategy: Pubkey,
    pub index: u64,
    pub fixture_id: i64,
    pub market: u16,
    pub side: u8,
    pub fair_prob_bps: u16,
    pub entry_odds_milli: u32,
    pub stake: u64,
    pub signal_hash: [u8; 32],
    pub nonce: [u8; 32],
}

/// Settle inputs: the reveal, the claimed 1X2 result, and the score proof pieces
/// for the home and away goal stats. The predicate is derived on-chain from the
/// claim, so a passing validate_stat CPI proves the real result matches the claim.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SettleArgs {
    pub reveal: RevealArgs,
    pub claimed_result: u8,
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub stat_home: StatTerm,
    pub stat_away: StatTerm,
}

#[event]
pub struct DecisionCommitted {
    pub strategy: Pubkey,
    pub index: u64,
    pub commit_hash: [u8; 32],
    pub fixture_id: i64,
    pub market: u16,
    pub commit_slot: u64,
}

#[event]
pub struct DecisionSettled {
    pub strategy: Pubkey,
    pub index: u64,
    pub won: bool,
    pub pnl: i64,
    pub settle_slot: u64,
}

#[event]
pub struct DecisionVoided {
    pub strategy: Pubkey,
    pub index: u64,
}
