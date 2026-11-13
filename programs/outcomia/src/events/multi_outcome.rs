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

#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MultiOutcomeOrderEvent {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub order: Pubkey,
    pub outcome: crate::OutcomeId,
    pub side: crate::OrderSide,
    pub price: u64,
    pub quantity: u64,
    pub status: crate::OrderStatus,
}
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MultiOutcomeFillEvent {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub order: Pubkey,
    pub outcome: crate::OutcomeId,
    pub taker_side: crate::OrderSide,
    pub price: u64,
    pub quantity: u64,
    pub collateral_atoms: u64,
    pub fee_atoms: u64,
}
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MultiOutcomeFeeWithdrawnEvent {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub amount: u64,
}

#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MultiOutcomeResolutionEvent {
    pub market: Pubkey,
    pub outcome: Option<crate::MultiOutcomeResolution>,
    pub status: PredictionStatus,
}
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MultiOutcomeRedeemedEvent {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub outcome: crate::MultiOutcomeResolution,
    pub quantities: [u64; 8],
    pub payout: u64,
    pub backing_reserve: u64,
}
