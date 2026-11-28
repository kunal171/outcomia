//! Outcome disputes (club rules milestone 3).
//!
//! Every prediction market, binary or multi-outcome, gets a dispute window
//! after its proposal: longer for club markets. A holder may dispute once, with
//! a bond; a protocol admin who is neither the market's creator nor its
//! resolver (nor, for a club market, a club admin) rules, and the ruling is
//! final. Without a ruling in time the market becomes invalid.

use anchor_lang::prelude::*;

/// Platform dispute settings, set by the super-admin.
///
/// PDA: ["dispute_config"]. Proposals require it, so every new proposal records
/// the window it runs under.
#[account]
#[derive(InitSpace, Debug)]
pub struct DisputeConfig {
    /// Dispute window after a club market's proposal, in seconds (5 days).
    pub club_window_seconds: u64,
    /// Dispute window after any other market's proposal, in seconds (3 days).
    pub regular_window_seconds: u64,
    /// Bond in whole collateral tokens (1 = 1 USDC).
    pub bond_tokens: u64,
    /// Time an admin has to rule before the market becomes invalid (7 days).
    pub ruling_deadline_seconds: u64,
    /// Wallet receiving upheld bonds (and, from M4, penalty shares).
    pub treasury: Pubkey,
    pub bump: u8,
    /// Zeroed space for M4 penalty settings.
    pub reserved: [u8; 64],
}

/// Where a market's dispute stands.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum DisputeState {
    /// No dispute yet; one may be opened during the window.
    None,
    /// Waiting for a ruling; the market cannot be finalized.
    Open,
    /// The proposed outcome stands; the bond went to the treasury.
    Upheld,
    /// An admin chose another outcome; the bond was refunded.
    Overturned,
    /// An admin ruled the market invalid; the bond was refunded.
    Invalidated,
    /// Nobody ruled in time: the market became invalid, the bond was refunded.
    Expired,
}

/// Per-market dispute record, created with the market's first proposal.
///
/// PDA: ["market_dispute", market]. Its bond sits in the token account
/// ["dispute_bond", market], whose authority is this record.
#[account]
#[derive(InitSpace, Debug)]
pub struct MarketDispute {
    pub market: Pubkey,
    /// Window length fixed at the first proposal; corrections restart it.
    pub window_seconds: u64,
    pub club_market: bool,
    pub state: DisputeState,
    pub disputer: Pubkey,
    pub bond_mint: Pubkey,
    pub bond_amount: u64,
    pub opened_at: i64,
    /// Last instant (exclusive) for a ruling; fixed when the dispute opens.
    pub ruling_deadline: i64,
    /// Admin who ruled, if any.
    pub ruled_by: Option<Pubkey>,
    /// A club market was overturned or ruled invalid; M4 deducts the penalty.
    pub club_penalty_due: bool,
    pub bump: u8,
    /// Zeroed space for later dispute data.
    pub reserved: [u8; 32],
}

/// An admin's ruling on a binary market's dispute.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PredictionRuling {
    Uphold,
    Overturn(super::PredictionResolution),
    Invalid,
}

/// An admin's ruling on a multi-outcome market's dispute.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MultiOutcomeRuling {
    Uphold,
    Overturn(super::OutcomeId),
    Invalid,
}
