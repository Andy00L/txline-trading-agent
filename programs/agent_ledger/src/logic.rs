use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;

use crate::state::{RevealArgs, SIDE_AWAY, SIDE_DRAW, SIDE_HOME};
use crate::txline_cpi::Comparison;

/// commit_hash = keccak256(borsh(RevealArgs)). Deterministic; binds every sealed field.
pub fn compute_commit_hash(reveal: &RevealArgs) -> Result<[u8; 32]> {
    let bytes = reveal.try_to_vec()?;
    Ok(keccak::hashv(&[bytes.as_slice()]).0)
}

/// The predicate that must hold over (home goals - away goals) for a claimed 1X2
/// result: home wins is above 0, draw is exactly 0, away wins is below 0.
pub fn predicate_for_claim(claimed_result: u8) -> Option<(Comparison, i32)> {
    match claimed_result {
        SIDE_HOME => Some((Comparison::GreaterThan, 0)),
        SIDE_DRAW => Some((Comparison::EqualTo, 0)),
        SIDE_AWAY => Some((Comparison::LessThan, 0)),
        _ => None,
    }
}

/// Signed PnL in paper micro-USDC: profit stake*(odds-1) on a win, -stake on a loss.
pub fn compute_pnl(won: bool, stake: u64, entry_odds_milli: u32) -> Option<i64> {
    if won {
        let net = (entry_odds_milli as u64).checked_sub(1000)?;
        let profit = stake.checked_mul(net)? / 1000;
        i64::try_from(profit).ok()
    } else {
        i64::try_from(stake).ok().map(|amount| -amount)
    }
}

/// Apply signed PnL to a non-negative bankroll, saturating at 0.
pub fn apply_pnl(bankroll: u64, pnl: i64) -> Option<u64> {
    if pnl >= 0 {
        bankroll.checked_add(pnl as u64)
    } else {
        Some(bankroll.saturating_sub(pnl.unsigned_abs()))
    }
}

/// The 2-byte little-endian epoch day used in the daily scores roots PDA seed.
pub fn epoch_day_le(ts_ms: i64) -> [u8; 2] {
    ((ts_ms / 86_400_000) as u16).to_le_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pnl_win_returns_profit() {
        assert_eq!(compute_pnl(true, 100_000_000, 2000), Some(100_000_000));
        assert_eq!(compute_pnl(true, 100_000_000, 3000), Some(200_000_000));
    }

    #[test]
    fn pnl_loss_returns_minus_stake() {
        assert_eq!(compute_pnl(false, 100_000_000, 2000), Some(-100_000_000));
    }

    #[test]
    fn predicate_matches_claim() {
        assert_eq!(predicate_for_claim(SIDE_HOME), Some((Comparison::GreaterThan, 0)));
        assert_eq!(predicate_for_claim(SIDE_DRAW), Some((Comparison::EqualTo, 0)));
        assert_eq!(predicate_for_claim(SIDE_AWAY), Some((Comparison::LessThan, 0)));
        assert_eq!(predicate_for_claim(7), None);
    }

    #[test]
    fn commit_hash_is_deterministic_and_binds_every_field() {
        let reveal = RevealArgs {
            strategy: Pubkey::new_from_array([1u8; 32]),
            index: 0,
            fixture_id: 17_588_227,
            market: 0,
            side: SIDE_HOME,
            fair_prob_bps: 5000,
            entry_odds_milli: 2000,
            stake: 100,
            signal_hash: [2u8; 32],
            nonce: [3u8; 32],
        };
        let first = compute_commit_hash(&reveal).unwrap();
        assert_eq!(first, compute_commit_hash(&reveal).unwrap());

        let mut tampered = reveal.clone();
        tampered.side = SIDE_AWAY;
        assert_ne!(compute_commit_hash(&tampered).unwrap(), first);
    }

    #[test]
    fn apply_pnl_saturates_at_zero() {
        assert_eq!(apply_pnl(1000, 500), Some(1500));
        assert_eq!(apply_pnl(1000, -300), Some(700));
        assert_eq!(apply_pnl(100, -500), Some(0));
    }

    #[test]
    fn epoch_day_is_two_byte_le() {
        assert_eq!(epoch_day_le(1_750_000_000_000), 20254u16.to_le_bytes());
    }

    // Canonical reveal used as the cross-language golden. The onchain-client TS
    // borsh-encoder and keccak must reproduce this exact hash, or settles fail.
    fn canonical_reveal() -> RevealArgs {
        RevealArgs {
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
        }
    }

    #[test]
    fn canonical_commit_hash_is_stable() {
        let hash = compute_commit_hash(&canonical_reveal()).unwrap();
        let hex: String = hash.iter().map(|byte| format!("{:02x}", byte)).collect();
        // The onchain-client TS encoder reproduces this exact value
        // (packages/onchain-client/src/commit-hash.test.ts). Changing the
        // RevealArgs layout breaks the commit-reveal binding; update both sides.
        assert_eq!(hex, "1244a9767dcb28206a7da4ad1904def66f98d0ee1f879da348e6df75eea86b92");
    }
}
