use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;

// Mirror of the txoracle IDL types, byte-for-byte, so borsh-encoding them produces
// the exact instruction data validate_stat expects.
// sourceRef: docs/research/M0-recon-findings.md (on-chain types).

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

// Anchor instruction discriminator = sha256("global:validate_stat")[0..8]. It is
// derived from the instruction name, so it is stable across txoracle IDL versions.
// sourceRef: docs/research/M0-recon-findings.md (validate_stat discriminator).
pub const VALIDATE_STAT_DISCRIMINATOR: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

#[derive(AnchorSerialize)]
struct ValidateStatIxArgs {
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
}

/// CPI into txoracle::validate_stat. It reads only daily_scores_merkle_roots and
/// reverts on a bad proof, a false predicate, or a missing root, so a call that
/// returns proves the predicate holds against the on-chain scores root.
#[allow(clippy::too_many_arguments)]
pub fn cpi_validate_stat<'info>(
    txline_program: AccountInfo<'info>,
    daily_scores_merkle_roots: AccountInfo<'info>,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
) -> Result<()> {
    let args = ValidateStatIxArgs {
        ts,
        fixture_summary,
        fixture_proof,
        main_tree_proof,
        predicate,
        stat_a,
        stat_b,
        op,
    };

    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&VALIDATE_STAT_DISCRIMINATOR);
    data.extend_from_slice(&args.try_to_vec()?);

    let instruction = Instruction {
        program_id: *txline_program.key,
        accounts: vec![AccountMeta::new_readonly(*daily_scores_merkle_roots.key, false)],
        data,
    };
    invoke(&instruction, &[daily_scores_merkle_roots, txline_program])?;
    Ok(())
}
