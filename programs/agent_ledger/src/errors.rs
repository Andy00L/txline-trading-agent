use anchor_lang::prelude::*;

#[error_code]
pub enum AgentError {
    #[msg("Decision is not open")]
    NotOpen,
    #[msg("Reveal does not match the committed hash")]
    CommitMismatch,
    #[msg("Reveal fixture, market, or strategy does not match the decision")]
    RoutingMismatch,
    #[msg("CPI target is not the strategy's pinned txline program")]
    TxlineProgramMismatch,
    #[msg("Claimed result is not a valid 1X2 side")]
    InvalidClaim,
    #[msg("Daily scores roots account does not match the timestamp")]
    InvalidRootsPda,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Void grace window has elapsed; settle instead")]
    VoidGraceElapsed,
}
