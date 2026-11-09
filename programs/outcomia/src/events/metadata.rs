//! Events describing creation and presentation-only updates of market metadata.

use anchor_lang::prelude::*;

use crate::state::MarketKind;

/// Records the first human-readable identity attached to a market.
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MarketMetadataInitializedEvent {
    pub metadata: Pubkey,
    pub market: Pubkey,
    pub authority: Pubkey,
    pub base_symbol: String,
    pub quote_symbol: String,
    pub display_name: String,
    pub kind: MarketKind,
}

/// Records mutable label changes while deliberately omitting `kind`.
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MarketMetadataUpdatedEvent {
    pub metadata: Pubkey,
    pub market: Pubkey,
    pub authority: Pubkey,
    pub base_symbol: String,
    pub quote_symbol: String,
    pub display_name: String,
}

/// Records rent-reclaiming metadata cleanup before its market is closed.
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct MarketMetadataClosedEvent {
    pub metadata: Pubkey,
    pub market: Pubkey,
    pub authority: Pubkey,
    pub kind: MarketKind,
}
