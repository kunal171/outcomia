//! Persistent account layouts and enum state shared across instructions.
//!
//! Any layout change affects already-created accounts and therefore requires an
//! explicit migration or a fresh deployment during the research phase.

use anchor_lang::prelude::*;

pub mod shared;
pub use shared::*;

pub mod prediction;
pub use prediction::*;
pub mod prediction_book;
pub use prediction_book::*;

/// Configuration and lifecycle state for one ordered base/quote market.
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub status: MarketStatus,
    /// Monotonic market-local ID assigned to the next submitted order.
    pub next_order_id: u64,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    /// Minimum price increment in raw quote-price units.
    pub price_tick_size: u64,
    /// Minimum quantity increment in base-mint atoms.
    pub quantity_lot_size: u64,
    /// Highest-priority open bid price, or `None` when the bid side is empty.
    pub best_bid: Option<u64>,
    /// Highest-priority open ask price, or `None` when the ask side is empty.
    pub best_ask: Option<u64>,
    /// Number of orders still eligible for matching or cancellation.
    pub open_order_count: u64,
    pub bump: u8,
}

/// Selects the settlement model associated with a market.
///
/// Variant order is serialized state. Append future variants instead of
/// inserting them between existing variants.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketKind {
    /// Existing base/quote SPL-token markets.
    Spot,
    /// Collateral-backed binary markets with internal YES/NO positions.
    Prediction,
    /// Explicitly experimental market models.
    Other,
}

/// Human-readable labels and classification kept outside critical book state.
///
/// Separating this account from `Market` lets existing markets opt in without
/// reallocating or migrating their matching-engine account.
///
/// Maximum Borsh payload: 32-byte market + two (4-byte length + 16-byte symbol)
/// strings + (4 + 64)-byte name + 1-byte kind + 1-byte bump = 142 bytes.
/// Anchor adds an 8-byte discriminator, so allocation is 150 bytes. InitSpace
/// computes that bound; write handlers must still reject oversized strings.
#[account]
#[derive(InitSpace)]
pub struct MarketMetadata {
    /// Market described by this canonical metadata PDA.
    pub market: Pubkey,
    /// Short base-asset label such as "SOL" or "tSOL".
    #[max_len(16)]
    pub base_symbol: String,
    /// Short quote-asset label such as "USDC" or "tUSDC".
    #[max_len(16)]
    pub quote_symbol: String,
    /// Client-facing name, independent of the market's immutable address.
    #[max_len(64)]
    pub display_name: String,
    /// Immutable classification selected when metadata is initialized.
    pub kind: MarketKind,
    /// Canonical metadata PDA bump.
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketStatus {
    Active,
    Paused,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum OrderSide {
    Bid,
    Ask,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum OrderStatus {
    Open,
    Filled,
    Canceled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum AdminStatus {
    Active,
    Disabled,
}

#[account]
#[derive(InitSpace)]
/// One order submission and its mutable queue and lifecycle state.
pub struct Order {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub order_id: u64,
    pub side: OrderSide,
    pub price: u64,
    /// Canonical price-level PDA containing this order.
    pub price_level: Pubkey,
    /// Older order at the same price.
    pub previous_order: Option<Pubkey>,
    /// Newer order at the same price.
    pub next_order: Option<Pubkey>,
    pub quantity: u64,
    pub remaining_quantity: u64,
    /// Base atoms for asks or quote atoms for bids currently held in custody.
    pub locked_collateral: u64,
    pub status: OrderStatus,
    pub bump: u8,
}

/// Singleton governance state created by the program upgrade authority.
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub super_admin: Pubkey,

    /// Global fee charged to takers, expressed in basis points.
    ///
    /// One basis point is 0.01%. The value is validated against
    /// `MAX_TAKER_FEE_BPS` whenever governance updates it.
    pub taker_fee_bps: u16,

    pub bump: u8,
}

/// Quote-denominated protocol fees accumulated by one market.
///
/// The corresponding tokens remain inside the market's canonical quote vault
/// for spot, or collateral vault for prediction markets. In the latter case
/// `quote_mint` denotes the single collateral mint; the shared record layout
/// does not make spot withdrawal contexts accept prediction-market accounts.
/// This account records how many quote atoms belong to the protocol instead of
/// traders, preserving the conservation equation:
///
/// quote vault = trader claims + accrued protocol fees
#[account]
#[derive(InitSpace)]
pub struct MarketFees {
    /// Market whose quote vault backs this accumulator.
    pub market: Pubkey,

    /// Quote mint in which all fees are denominated.
    pub quote_mint: Pubkey,

    /// Quote atoms earned by the protocol but not yet withdrawn.
    pub accrued_quote_fees: u64,

    /// Canonical market-fees PDA bump.
    pub bump: u8,
}

/// Permissionless dispenser configuration for one explicitly selected test market.
///
/// The account is intentionally opt-in and governance-controlled because an
/// on-chain program cannot determine which Solana cluster it is executing on.
/// Only valueless development mints should ever transfer authority to its PDA.
#[account]
#[derive(InitSpace)]
pub struct TestFaucet {
    /// Market whose two assets may be minted by this faucet.
    pub market: Pubkey,

    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,

    /// Fixed atomic amounts issued by every permissionless claim.
    pub base_claim_amount: u64,
    pub quote_claim_amount: u64,

    /// Bump for the stateless mint-authority PDA.
    pub authority_bump: u8,

    /// Bump for this configuration account.
    pub bump: u8,
}

/// Independent role record used to authorize market creation.
#[account]
#[derive(InitSpace)]
pub struct AdminRecord {
    pub authority: Pubkey,
    pub added_by: Pubkey,
    pub status: AdminStatus,
    pub bump: u8,
}

/// One active price in a market-side order-book index.
#[account]
#[derive(InitSpace)]
pub struct PriceLevel {
    /// Market containing this price level.
    pub market: Pubkey,

    /// Bid or ask side.
    pub side: OrderSide,

    /// Tick-aligned price shared by every order in this queue.
    pub price: u64,

    /// Adjacent price with higher matching priority.
    pub better_price: Option<u64>,

    /// Adjacent price with lower matching priority.
    pub worse_price: Option<u64>,

    /// Oldest open order at this price.
    pub first_order: Option<Pubkey>,

    /// Newest open order at this price.
    pub last_order: Option<Pubkey>,

    /// Sum of remaining base quantity across queued orders.
    pub total_remaining_quantity: u64,

    /// Number of open orders at this price.
    pub order_count: u64,

    /// Wallet that receives rent when this level is closed.
    pub rent_payer: Pubkey,

    /// Canonical price-level PDA bump.
    pub bump: u8,
}

/// Canonical internal balance ledger for one trader in one market.
///
/// Tokens represented here physically remain in the market's SPL token vaults.
/// `free` balances can be withdrawn or committed to new orders.
/// `locked` balances collateralize currently open orders.
///
/// There is exactly one account for each `(market, owner)` pair.
#[account]
#[derive(InitSpace)]
pub struct TraderBalance {
    /// Market whose vault assets back these balances.
    pub market: Pubkey,

    /// Wallet that owns this balance record.
    pub owner: Pubkey,

    /// Base tokens available for withdrawal or new ask orders.
    pub base_free: u64,

    /// Base tokens reserved by open ask orders.
    pub base_locked: u64,

    /// Quote tokens available for withdrawal or new bid orders.
    pub quote_free: u64,

    /// Quote tokens reserved by open bid orders.
    pub quote_locked: u64,

    /// Canonical PDA bump used to validate this market/owner ledger.
    pub bump: u8,
}

impl OrderSide {
    /// Stable PDA seed independent of Rust enum representation.
    ///
    /// # Inputs
    /// `self`: Bid or Ask; no account data is read.
    ///
    /// # Errors
    /// None; this is an infallible enum-to-byte mapping.
    ///
    /// # Returns
    /// Static `b"bid"` or `b"ask"`; these textual seeds are independent of serialized enum tags.
    pub const fn seed(self) -> &'static [u8] {
        match self {
            Self::Bid => b"bid",
            Self::Ask => b"ask",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_account_size_is_stable() {
        // Excludes Anchor's 8-byte account discriminator.
        assert_eq!(Order::INIT_SPACE, 205);
    }

    #[test]
    fn price_level_account_size_is_stable() {
        // Excludes Anchor's 8-byte account discriminator.
        assert_eq!(PriceLevel::INIT_SPACE, 174);
    }

    #[test]
    fn trader_balance_account_size_is_stable() {
        // Excludes Anchor's 8-byte account discriminator.
        assert_eq!(TraderBalance::INIT_SPACE, 97);
    }

    #[test]
    fn protocol_config_account_size_is_stable() {
        // Pubkey + u16 fee rate + PDA bump. Excludes Anchor's discriminator.
        assert_eq!(ProtocolConfig::INIT_SPACE, 35);
    }

    #[test]
    fn market_fees_account_size_is_stable() {
        // Market + quote mint + accrued u64 fees + PDA bump. Excludes the
        // 8-byte Anchor account discriminator.
        assert_eq!(MarketFees::INIT_SPACE, 73);
    }

    #[test]
    fn market_metadata_account_size_is_stable() {
        // Market key, three length-prefixed bounded strings, enum tag, and
        // bump. Excludes Anchor's 8-byte account discriminator.
        assert_eq!(MarketMetadata::INIT_SPACE, 142);
    }

    #[test]
    fn test_faucet_account_size_is_stable() {
        // Three public keys, two u64 claim amounts, and two PDA bumps. Excludes
        // Anchor's 8-byte account discriminator.
        assert_eq!(TestFaucet::INIT_SPACE, 114);
    }

    #[test]
    fn order_side_seeds_are_stable_and_distinct() {
        assert_eq!(OrderSide::Bid.seed(), b"bid");
        assert_eq!(OrderSide::Ask.seed(), b"ask");
        assert_ne!(OrderSide::Bid.seed(), OrderSide::Ask.seed());
    }
}
