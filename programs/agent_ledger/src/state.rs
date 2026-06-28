use anchor_lang::prelude::*;

use crate::txline_cpi::{Odds, OddsBatchSummary, ProofNode, ScoresBatchSummary, StatTerm};

// Decision lifecycle.
pub const STATUS_OPEN: u8 = 0;
pub const STATUS_SETTLED: u8 = 1;
pub const STATUS_VOID: u8 = 2;

// 1X2 result sides in participant space: side 0 = participant 1 wins, 1 = draw,
// 2 = participant 2 wins. The off-chain agent seals reveal.side and derives claimed_result
// in this same space (participant 1 is labelled "home" off-chain). sourceRef:
// docs/research/M0-recon-findings.md (the 1X2 market and stat keys are participant-indexed).
pub const SIDE_HOME: u8 = 0;
pub const SIDE_DRAW: u8 = 1;
pub const SIDE_AWAY: u8 = 2;

// Canonical 1X2 settle stats: full-time participant goal keys (base 1 = participant 1 goals,
// 2 = participant 2 goals; period 0 = full game). settle pins the two stats to these so the
// (stat_home - stat_away) predicate always tests participant 1 vs participant 2 goals and the
// stats cannot be swapped to make a chosen claim hold. sourceRef: M0-recon-findings.md A-3.
pub const STAT_KEY_PARTICIPANT1: u32 = 1;
pub const STAT_KEY_PARTICIPANT2: u32 = 2;
pub const FULL_GAME_PERIOD: i32 = 0;

// The 1X2 result market's SuperOddsType in the odds feed, pinned so an entry-odds proof must be
// for the same 1X2 market the decision committed (not an Over/Under or handicap snapshot whose
// prices happen to match). sourceRef: domain/market.ts SUPER_ODDS_TYPE_1X2 (O2).
pub const SUPER_ODDS_TYPE_1X2: &str = "1X2_PARTICIPANT_RESULT";

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
    /// Count of voided decisions (postponed/abandoned within the grace window). In 1X2 there is no
    /// betting "push": a drawn match is a real win or loss of the staked side (booked in wins/losses
    /// via won), so this counts voids only, not drawn results. sourceRef: void_decision.
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
    /// Set true once prove_entry_odds binds the sealed entry odds to a proven in-tree price. The
    /// outcome is proven at settle; this proves the entry price was a real published quote too.
    pub entry_odds_proven: bool,
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

/// Inputs to prove the sealed entry odds were a real published price. The reveal is re-checked
/// against the commit hash, so the bound entry_odds_milli is the committed one; side_index points
/// at the backed 1X2 side in the snapshot's parallel price_names/prices arrays. The handler binds
/// prices[side_index] to the sealed entry odds for the committed fixture and side, then a CPI into
/// validate_odds proves the snapshot is a leaf of the published odds batch tree.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProveOddsArgs {
    pub reveal: RevealArgs,
    pub ts: i64,
    pub odds_snapshot: Odds,
    pub summary: OddsBatchSummary,
    pub sub_tree_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub side_index: u8,
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
pub struct DecisionOddsProven {
    pub strategy: Pubkey,
    pub index: u64,
}

#[event]
pub struct DecisionVoided {
    pub strategy: Pubkey,
    pub index: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::txline_cpi::{
        Odds, OddsBatchSummary, OddsUpdateStats, ProofNode, ScoreStat, ScoresUpdateStats, StatTerm,
    };

    // Canonical settle inputs pinned as a cross-language golden. The onchain-client
    // TS encoder must reproduce this exact borsh (settle-encode.test.ts).
    fn canonical_settle() -> SettleArgs {
        SettleArgs {
            reveal: RevealArgs {
                strategy: Pubkey::new_from_array([1u8; 32]),
                index: 1,
                fixture_id: 17_588_227,
                market: 0,
                side: SIDE_HOME,
                fair_prob_bps: 5263,
                entry_odds_milli: 2100,
                stake: 25_000_000,
                signal_hash: [7u8; 32],
                nonce: [9u8; 32],
            },
            claimed_result: SIDE_HOME,
            ts: 1_750_000_000_000,
            fixture_summary: ScoresBatchSummary {
                fixture_id: 17_588_227,
                update_stats: ScoresUpdateStats {
                    update_count: 5,
                    min_timestamp: 1_750_000_000_000,
                    max_timestamp: 1_750_000_300_000,
                },
                events_sub_tree_root: [10u8; 32],
            },
            fixture_proof: vec![ProofNode { hash: [11u8; 32], is_right_sibling: true }],
            main_tree_proof: vec![ProofNode { hash: [12u8; 32], is_right_sibling: false }],
            stat_home: StatTerm {
                stat_to_prove: ScoreStat { key: 1, value: 2, period: 0 },
                event_stat_root: [13u8; 32],
                stat_proof: vec![ProofNode { hash: [14u8; 32], is_right_sibling: true }],
            },
            stat_away: StatTerm {
                stat_to_prove: ScoreStat { key: 2, value: 1, period: 0 },
                event_stat_root: [13u8; 32],
                stat_proof: vec![ProofNode { hash: [15u8; 32], is_right_sibling: false }],
            },
        }
    }

    #[test]
    fn canonical_settle_args_borsh_is_stable() {
        let bytes = canonical_settle().try_to_vec().unwrap();
        let hex: String = bytes.iter().map(|byte| format!("{:02x}", byte)).collect();
        // The onchain-client TS encoder reproduces this exact borsh
        // (packages/onchain-client/src/settle-encode.test.ts). Keep both in sync.
        assert_eq!(
            hex,
            "0101010101010101010101010101010101010101010101010101010101010101010000000000000003600c01000000000000008f143408000040787d0100000000070707070707070707070707070707070707070707070707070707070707070709090909090909090909090909090909090909090909090909090909090909090000dc20749701000003600c01000000000500000000dc207497010000e06f2574970100000a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010000000b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b01010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c000100000002000000000000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d010000000e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e010200000001000000000000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d010000000f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f00"
        );
    }

    // Canonical prove-entry-odds inputs pinned as a cross-language golden. The onchain-client TS
    // encoder must reproduce this exact borsh (prove-odds-encode.test.ts). The snapshot is a valid
    // 1X2 row: side HOME at index 0, price_names[0] = "1", prices[0] = 2100 = entry_odds_milli.
    fn canonical_prove_odds() -> ProveOddsArgs {
        ProveOddsArgs {
            reveal: RevealArgs {
                strategy: Pubkey::new_from_array([1u8; 32]),
                index: 1,
                fixture_id: 17_588_227,
                market: 0,
                side: SIDE_HOME,
                fair_prob_bps: 5263,
                entry_odds_milli: 2100,
                stake: 25_000_000,
                signal_hash: [7u8; 32],
                nonce: [9u8; 32],
            },
            ts: 1_750_000_000_000,
            odds_snapshot: Odds {
                fixture_id: 17_588_227,
                message_id: "msg-1".to_string(),
                ts: 1_750_000_000_000,
                bookmaker: "TXLineStablePriceDemargined".to_string(),
                bookmaker_id: 0,
                super_odds_type: "1X2_PARTICIPANT_RESULT".to_string(),
                game_state: None,
                in_running: false,
                market_parameters: Some(String::new()),
                market_period: None,
                price_names: vec!["1".to_string(), "X".to_string(), "2".to_string()],
                prices: vec![2100, 3400, 3600],
            },
            summary: OddsBatchSummary {
                fixture_id: 17_588_227,
                update_stats: OddsUpdateStats {
                    update_count: 5,
                    min_timestamp: 1_750_000_000_000,
                    max_timestamp: 1_750_000_300_000,
                },
                odds_sub_tree_root: [13u8; 32],
            },
            sub_tree_proof: vec![ProofNode { hash: [14u8; 32], is_right_sibling: true }],
            main_tree_proof: vec![ProofNode { hash: [15u8; 32], is_right_sibling: false }],
            side_index: 0,
        }
    }

    #[test]
    fn canonical_prove_odds_args_borsh_is_stable() {
        let bytes = canonical_prove_odds().try_to_vec().unwrap();
        let hex: String = bytes.iter().map(|byte| format!("{:02x}", byte)).collect();
        // The onchain-client TS encoder reproduces this exact borsh
        // (packages/onchain-client/src/prove-odds-encode.test.ts). Keep both in sync.
        assert_eq!(
            hex,
            "0101010101010101010101010101010101010101010101010101010101010101010000000000000003600c01000000000000008f143408000040787d01000000000707070707070707070707070707070707070707070707070707070707070707090909090909090909090909090909090909090909090909090909090909090900dc20749701000003600c0100000000050000006d73672d3100dc2074970100001b00000054584c696e65537461626c65507269636544656d617267696e656400000000160000003158325f5041525449434950414e545f524553554c540000010000000000030000000100000031010000005801000000320300000034080000480d0000100e000003600c01000000000500000000dc207497010000e06f2574970100000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d010000000e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e01010000000f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0000"
        );
    }
}
