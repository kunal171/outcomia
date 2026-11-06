//! Protocol-wide cash accounts and independently namespaced shared-wallet books.
//!
//! Legacy layouts are retained for recovery. A market position still owns its
//! YES/NO claims; only fungible cash is reusable across market boundaries.
use super::{MarketKind, OrderSide, OrderStatus};
use crate::errors::shared;
use anchor_lang::prelude::*;

/// Exactly one account per `(wallet, mint)`, with no market in its PDA seeds.
#[account]
#[derive(InitSpace)]
pub struct AssetBalance {
    pub owner: Pubkey,
    pub mint: Pubkey,
    /// Spendable atoms, backed by the mint's global vault.
    pub free: u64,
    /// Atoms committed to open shared-wallet orders across all markets.
    pub locked: u64,
    pub bump: u8,
}

/// Spot uses the Spot list; predictions have separate YES and NO lists.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum SharedOutcome {
    Spot,
    Yes,
    No,
}
impl SharedOutcome {
    /// Inputs: outcome. Errors: none. Returns: stable textual PDA seed.
    pub const fn seed(self) -> &'static [u8] {
        match self {
            Self::Spot => b"spot",
            Self::Yes => b"yes",
            Self::No => b"no",
        }
    }
}

/// Book-local indexing and fees; it never owns a trader's available cash.
#[account]
#[derive(InitSpace)]
pub struct SharedBook {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub kind: MarketKind,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub price_tick: u64,
    pub quantity_lot: u64,
    pub payout_per_contract: u64,
    /// Spot uses slots 0/1; prediction YES uses 0/1 and NO uses 2/3.
    pub best_prices: [Option<u64>; 4],
    pub next_order_id: u64,
    pub open_order_count: u64,
    /// Quote atoms backed by the global quote vault, not a legacy market vault.
    pub accrued_quote_fees: u64,
    pub bump: u8,
}
impl SharedBook {
    /// Inputs: outcome/side. Errors: mismatched market kind. Returns: head index.
    pub fn slot(&self, outcome: SharedOutcome, side: OrderSide) -> Result<usize> {
        let group = match (self.kind, outcome) {
            (MarketKind::Spot, SharedOutcome::Spot)
            | (MarketKind::Prediction, SharedOutcome::Yes) => 0,
            (MarketKind::Prediction, SharedOutcome::No) => 2,
            _ => return err!(shared::SharedMarketKindMismatch),
        };
        Ok(group + usize::from(side == OrderSide::Ask))
    }
}

/// History is retained after fills/cancellation. Only Open remainders lock funds.
#[account]
#[derive(InitSpace)]
pub struct SharedOrder {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub book: Pubkey,
    pub order_id: u64,
    pub outcome: SharedOutcome,
    pub side: OrderSide,
    pub price: u64,
    pub price_level: Pubkey,
    pub previous_order: Option<Pubkey>,
    pub next_order: Option<Pubkey>,
    pub quantity: u64,
    pub remaining_quantity: u64,
    /// Asset atoms for bids/spot asks, whole contracts for prediction asks.
    pub locked_collateral: u64,
    pub status: OrderStatus,
    pub bump: u8,
}

/// One price-time queue, with explicit reciprocal links and the original rent payer.
#[account]
#[derive(InitSpace)]
pub struct SharedPriceLevel {
    pub book: Pubkey,
    pub market: Pubkey,
    pub outcome: SharedOutcome,
    pub side: OrderSide,
    pub price: u64,
    pub better_price: Option<u64>,
    pub worse_price: Option<u64>,
    pub first_order: Option<Pubkey>,
    pub last_order: Option<Pubkey>,
    pub total_remaining_quantity: u64,
    pub order_count: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}
