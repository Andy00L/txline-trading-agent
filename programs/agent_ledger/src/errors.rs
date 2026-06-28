use anchor_lang::prelude::*;

#[error_code]
pub enum AgentError {
    #[msg("Decision is not open")]
    NotOpen,
    #[msg("Reveal does not match the committed hash")]
    CommitMismatch,
    #[msg("Reveal fixture, market, or strategy does not match the decision")]
    RoutingMismatch,
    #[msg("Proven fixture summary does not match the committed decision's fixture")]
    FixtureMismatch,
    #[msg("Settle stats are not the canonical participant goal keys at full time")]
    StatKeyMismatch,
    #[msg("CPI target is not the strategy's pinned txline program")]
    TxlineProgramMismatch,
    #[msg("Claimed result is not a valid 1X2 side")]
    InvalidClaim,
    #[msg("Sealed side is not a valid 1X2 side")]
    InvalidSide,
    #[msg("Daily scores roots account does not match the timestamp")]
    InvalidRootsPda,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Void grace window has elapsed; settle instead")]
    VoidGraceElapsed,
    #[msg("Entry odds can only be proven after the decision is settled")]
    NotSettled,
    #[msg("Entry odds are already proven for this decision")]
    OddsAlreadyProven,
    #[msg("Proven odds snapshot is not the committed 1X2 result market")]
    OddsMarketMismatch,
    #[msg("Odds price index is out of range or the price arrays are misaligned")]
    OddsIndexOutOfRange,
    #[msg("Odds price label does not match the sealed side")]
    OddsSideMismatch,
    #[msg("Proven odds price does not match the sealed entry odds")]
    OddsPriceMismatch,
}
