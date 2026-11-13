//! Multi-outcome lifecycle and physical reserve movements. Index only successful transactions.
use crate::state::PredictionStatus;
use anchor_lang::prelude::*;

#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MultiOutcomeMarketInitializedEvent {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub outcome_count: u8,
    pub payout_per_contract: u64,
    pub quantity_lot: u64,
}

#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MultiOutcomeMarketStatusEvent {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub status: PredictionStatus,
}

#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MultiOutcomePositionInitializedEvent {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub position: Pubkey,
}

#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MultiOutcomeCompleteSetEvent {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub collateral_mint: Pubkey,
    pub split: bool,
    pub quantity: u64,
    pub collateral_atoms: u64,
    pub backing_reserve: u64,
}
