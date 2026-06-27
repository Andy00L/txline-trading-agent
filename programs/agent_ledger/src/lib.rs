use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;

pub mod errors;
pub mod logic;
pub mod state;
pub mod txline_cpi;

use errors::AgentError;
use logic::{apply_pnl, compute_commit_hash, compute_pnl, epoch_day_le, predicate_for_claim};
use state::*;
use txline_cpi::{cpi_validate_stat, BinaryExpression, TraderPredicate};

declare_id!("FLZiKMUaPAGMtPLbfHvHwfiVfkTZD8RZ84CSrkDy1kLD");

#[program]
pub mod agent_ledger {
    use super::*;

    /// Create a strategy ledger and pin its CPI target (the txline program). Trust note: the
    /// txline_program is caller-supplied and only pinned thereafter, so a strategy is only as
    /// trustworthy as the program it pinned (a fake oracle would let that authority fabricate wins
    /// on its own ledger). A verifier must confirm a strategy's stored txline_program equals the
    /// real txoracle id before trusting its record; the judge-facing strategy is initialized with
    /// the real devnet txoracle id. sourceRef: M0-recon-findings.md, docs/audit/M8-audit.md.
    pub fn initialize_strategy(
        ctx: Context<InitializeStrategy>,
        strategy_id: u64,
        txline_program: Pubkey,
        starting_bankroll: u64,
    ) -> Result<()> {
        let strategy = &mut ctx.accounts.strategy;
        strategy.authority = ctx.accounts.authority.key();
        strategy.strategy_id = strategy_id;
        strategy.txline_program = txline_program;
        strategy.starting_bankroll = starting_bankroll;
        strategy.bankroll = starting_bankroll;
        strategy.realized_pnl = 0;
        strategy.decisions_count = 0;
        strategy.open_count = 0;
        strategy.settled_count = 0;
        strategy.wins = 0;
        strategy.losses = 0;
        strategy.pushes = 0;
        strategy.commit_log_root = [0u8; 32];
        strategy.bump = ctx.bumps.strategy;
        Ok(())
    }

    /// Commit a sealed decision before kickoff. Only routing fields are in the clear;
    /// the side, price, stake, and signal stay hashed until settle.
    pub fn commit_decision(
        ctx: Context<CommitDecision>,
        commit_hash: [u8; 32],
        fixture_id: i64,
        market: u16,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let strategy = &mut ctx.accounts.strategy;
        let index = strategy.decisions_count;

        let decision = &mut ctx.accounts.decision;
        decision.strategy = strategy.key();
        decision.index = index;
        decision.commit_hash = commit_hash;
        decision.fixture_id = fixture_id;
        decision.market = market;
        decision.commit_slot = clock.slot;
        decision.commit_unix_ts = clock.unix_timestamp;
        decision.status = STATUS_OPEN;
        decision.outcome_side = 0;
        decision.pnl = 0;
        decision.settle_slot = 0;
        decision.bump = ctx.bumps.decision;

        strategy.commit_log_root =
            keccak::hashv(&[&strategy.commit_log_root, &commit_hash, &index.to_le_bytes()]).0;
        strategy.decisions_count =
            strategy.decisions_count.checked_add(1).ok_or(AgentError::Overflow)?;
        strategy.open_count = strategy.open_count.checked_add(1).ok_or(AgentError::Overflow)?;

        emit!(DecisionCommitted {
            strategy: strategy.key(),
            index,
            commit_hash,
            fixture_id,
            market,
            commit_slot: clock.slot,
        });
        Ok(())
    }

    /// Reveal and settle. The reveal must match the sealed hash; the predicate is
    /// derived from the claim; a CPI into validate_stat proves the oracle score
    /// satisfies it before any PnL is written.
    pub fn settle_decision(ctx: Context<SettleDecision>, args: SettleArgs) -> Result<()> {
        require!(ctx.accounts.decision.status == STATUS_OPEN, AgentError::NotOpen);

        let computed = compute_commit_hash(&args.reveal)?;
        require!(computed == ctx.accounts.decision.commit_hash, AgentError::CommitMismatch);
        require!(
            args.reveal.fixture_id == ctx.accounts.decision.fixture_id
                && args.reveal.market == ctx.accounts.decision.market
                && args.reveal.strategy == ctx.accounts.strategy.key(),
            AgentError::RoutingMismatch
        );
        // The sealed side must be a valid 1X2 outcome. An out-of-range side can never equal a valid
        // claimed_result, so without this it would settle as a silent guaranteed loss rather than
        // failing loudly; the commit hash binds side, so this catches a malformed seal.
        require!(
            matches!(args.reveal.side, SIDE_HOME | SIDE_DRAW | SIDE_AWAY),
            AgentError::InvalidSide
        );

        // Bind the oracle proof to THIS decision's fixture: the proven summary must be for the
        // committed fixture, so a winning proof from a different match the same UTC day cannot
        // be substituted to fabricate a result.
        require!(
            args.fixture_summary.fixture_id == ctx.accounts.decision.fixture_id,
            AgentError::FixtureMismatch
        );
        // Pin the two settle stats to the canonical participant goal keys at full time. Without
        // this, stat_home and stat_away are caller-supplied and could be swapped so the
        // (stat_home - stat_away) predicate tests the winning participant regardless of the
        // sealed side; pinning forces it to test participant 1 vs participant 2 goals.
        require!(
            args.stat_home.stat_to_prove.key == STAT_KEY_PARTICIPANT1
                && args.stat_away.stat_to_prove.key == STAT_KEY_PARTICIPANT2
                && args.stat_home.stat_to_prove.period == FULL_GAME_PERIOD
                && args.stat_away.stat_to_prove.period == FULL_GAME_PERIOD,
            AgentError::StatKeyMismatch
        );

        require_keys_eq!(
            ctx.accounts.txline_program.key(),
            ctx.accounts.strategy.txline_program,
            AgentError::TxlineProgramMismatch
        );

        let (comparison, threshold) =
            predicate_for_claim(args.claimed_result).ok_or(AgentError::InvalidClaim)?;
        let epoch_day = epoch_day_le(args.ts).ok_or(AgentError::InvalidRootsPda)?;
        let (expected_roots, _bump) = Pubkey::find_program_address(
            &[b"daily_scores_roots", &epoch_day],
            &ctx.accounts.strategy.txline_program,
        );
        require_keys_eq!(
            ctx.accounts.daily_scores_merkle_roots.key(),
            expected_roots,
            AgentError::InvalidRootsPda
        );

        // Prove (participant 1 goals - participant 2 goals) satisfies the predicate. Reverts
        // the whole settle on a bad proof, a false predicate, or a missing root. validate_stat
        // is a pure assertion over a read-only account: it writes nothing and never touches
        // strategy or decision, so no account reload is needed after this CPI.
        cpi_validate_stat(
            ctx.accounts.txline_program.to_account_info(),
            ctx.accounts.daily_scores_merkle_roots.to_account_info(),
            args.ts,
            args.fixture_summary,
            args.fixture_proof,
            args.main_tree_proof,
            TraderPredicate { threshold, comparison },
            args.stat_home,
            Some(args.stat_away),
            Some(BinaryExpression::Subtract),
        )?;

        let won = args.claimed_result == args.reveal.side;
        let pnl = compute_pnl(won, args.reveal.stake, args.reveal.entry_odds_milli)
            .ok_or(AgentError::Overflow)?;
        let clock = Clock::get()?;

        let decision = &mut ctx.accounts.decision;
        decision.status = STATUS_SETTLED;
        decision.outcome_side = args.claimed_result;
        decision.pnl = pnl;
        decision.settle_slot = clock.slot;

        let strategy = &mut ctx.accounts.strategy;
        strategy.realized_pnl =
            strategy.realized_pnl.checked_add(pnl).ok_or(AgentError::Overflow)?;
        strategy.bankroll = apply_pnl(strategy.bankroll, pnl).ok_or(AgentError::Overflow)?;
        strategy.open_count = strategy.open_count.checked_sub(1).ok_or(AgentError::Overflow)?;
        strategy.settled_count =
            strategy.settled_count.checked_add(1).ok_or(AgentError::Overflow)?;
        if won {
            strategy.wins = strategy.wins.checked_add(1).ok_or(AgentError::Overflow)?;
        } else {
            strategy.losses = strategy.losses.checked_add(1).ok_or(AgentError::Overflow)?;
        }

        emit!(DecisionSettled {
            strategy: strategy.key(),
            index: decision.index,
            won,
            pnl,
            settle_slot: clock.slot,
        });
        Ok(())
    }

    /// Void a postponed or abandoned decision within the grace window. Requires the
    /// reveal to match, so a void cannot rewrite the sealed decision.
    pub fn void_decision(ctx: Context<VoidDecision>, reveal: RevealArgs, _reason: u8) -> Result<()> {
        require!(ctx.accounts.decision.status == STATUS_OPEN, AgentError::NotOpen);
        let computed = compute_commit_hash(&reveal)?;
        require!(computed == ctx.accounts.decision.commit_hash, AgentError::CommitMismatch);

        let clock = Clock::get()?;
        let elapsed = clock
            .unix_timestamp
            .checked_sub(ctx.accounts.decision.commit_unix_ts)
            .ok_or(AgentError::Overflow)?;
        require!(elapsed <= VOID_GRACE_SECONDS, AgentError::VoidGraceElapsed);

        let decision = &mut ctx.accounts.decision;
        decision.status = STATUS_VOID;
        decision.pnl = 0;
        decision.settle_slot = clock.slot;

        let strategy = &mut ctx.accounts.strategy;
        strategy.open_count = strategy.open_count.checked_sub(1).ok_or(AgentError::Overflow)?;
        strategy.pushes = strategy.pushes.checked_add(1).ok_or(AgentError::Overflow)?;

        emit!(DecisionVoided {
            strategy: strategy.key(),
            index: decision.index,
        });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(strategy_id: u64)]
pub struct InitializeStrategy<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Strategy::INIT_SPACE,
        seeds = [STRATEGY_SEED, authority.key().as_ref(), &strategy_id.to_le_bytes()],
        bump,
    )]
    pub strategy: Account<'info, Strategy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitDecision<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority,
        seeds = [STRATEGY_SEED, authority.key().as_ref(), &strategy.strategy_id.to_le_bytes()],
        bump = strategy.bump,
    )]
    pub strategy: Account<'info, Strategy>,
    #[account(
        init,
        payer = authority,
        space = 8 + DecisionCommit::INIT_SPACE,
        seeds = [COMMIT_SEED, strategy.key().as_ref(), &strategy.decisions_count.to_le_bytes()],
        bump,
    )]
    pub decision: Account<'info, DecisionCommit>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleDecision<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub strategy: Account<'info, Strategy>,
    #[account(
        mut,
        has_one = strategy,
        seeds = [COMMIT_SEED, strategy.key().as_ref(), &decision.index.to_le_bytes()],
        bump = decision.bump,
    )]
    pub decision: Account<'info, DecisionCommit>,
    /// CHECK: pinned and verified against strategy.txline_program in the handler.
    pub txline_program: UncheckedAccount<'info>,
    /// CHECK: re-derived from ts and verified in the handler; read-only, read by the CPI.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct VoidDecision<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub strategy: Account<'info, Strategy>,
    #[account(
        mut,
        has_one = strategy,
        seeds = [COMMIT_SEED, strategy.key().as_ref(), &decision.index.to_le_bytes()],
        bump = decision.bump,
    )]
    pub decision: Account<'info, DecisionCommit>,
}
