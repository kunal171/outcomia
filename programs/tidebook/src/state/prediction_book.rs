//! Prediction order-book layouts shared by initialization and placement.
//!
//! A separate root keeps index pointers out of already-created market accounts.
//! Each outcome has independent bid/ask price lists, while one root allocates
//! market-wide order IDs. Empty-side placement and same-price append check
//! funding and lifecycle gates; append also verifies the terminal FIFO links.
//! New-price insertion checks adjacent prices; cancellation unlinks FIFO nodes
//! and closes empty levels. Matching preserves these links on partial fills
//! and promotes the next FIFO order or price when a maker is fully filled.
//!
//! Borsh allocation counts serialized bytes, not Rust struct padding. A Pubkey
//! uses 32 bytes, u64 uses 8, and an Option adds a one-byte tag: `Option<u64>`
//! reserves 9 bytes, `Option<Pubkey>` reserves 33. For example, the book's payload
//! is 32 + 8 + 4*9 + 1 = 77 bytes, plus Anchor's 8-byte discriminator = 85.
//! None encodes only its tag, but allocation must still fit all Some values.

use super::{OrderSide, OrderStatus, PredictionOutcome};
use anchor_lang::prelude::*;

/// One index root per prediction market: ["prediction_book", market].
///
/// Keeping all four heads together costs one small account and simplifies
/// market-wide ID allocation. It also makes placements share a writable root;
/// this is a deliberate simplicity/parallelism tradeoff for the research book.
#[account]
#[derive(InitSpace)]
pub struct PredictionOrderBook {
    pub market: Pubkey,
    /// First submission will use 1. Advance with checked arithmetic; never
    /// reset this counter or recycle IDs while this market exists.
    pub next_order_id: u64,
    /// Highest live YES bid; None means that price list is empty.
    pub yes_best_bid: Option<u64>,
    /// Lowest live YES ask.
    pub yes_best_ask: Option<u64>,
    pub no_best_bid: Option<u64>,
    pub no_best_ask: Option<u64>,
    /// Canonical root bump. The market retains the sole open-order counter.
    pub bump: u8,
}

impl PredictionOrderBook {
    /// Select exactly one outcome/side list; complementary outcomes stay separate.
    ///
    /// # Inputs
    /// Borrowed root plus the outcome/side selector.
    ///
    /// # Errors
    /// None; an empty side is represented by `None`, not an error.
    ///
    /// # Returns
    /// Highest bid or lowest ask as `Option<u64>`; no other book state is inspected.
    pub fn best_price(&self, outcome: PredictionOutcome, side: OrderSide) -> Option<u64> {
        match (outcome, side) {
            (PredictionOutcome::Yes, OrderSide::Bid) => self.yes_best_bid,
            (PredictionOutcome::Yes, OrderSide::Ask) => self.yes_best_ask,
            (PredictionOutcome::No, OrderSide::Bid) => self.no_best_bid,
            (PredictionOutcome::No, OrderSide::Ask) => self.no_best_ask,
        }
    }

    /// Replaces exactly one prediction book head.
    ///
    /// # Inputs
    /// Mutable root, outcome/side and new `Option<u64>` price; `None` marks an empty list.
    ///
    /// # Errors
    /// None; caller must validate the canonical level and repaired links before changing its entry
    /// point.
    ///
    /// # Returns
    /// Updates the selected head in place; other heads and the global order ID stay unchanged.
    pub fn set_best_price(
        &mut self,
        outcome: PredictionOutcome,
        side: OrderSide,
        price: Option<u64>,
    ) {
        match (outcome, side) {
            (PredictionOutcome::Yes, OrderSide::Bid) => self.yes_best_bid = price,
            (PredictionOutcome::Yes, OrderSide::Ask) => self.yes_best_ask = price,
            (PredictionOutcome::No, OrderSide::Bid) => self.no_best_bid = price,
            (PredictionOutcome::No, OrderSide::Ask) => self.no_best_ask = price,
        }
    }
}

/// One FIFO queue: ["prediction_level", market, outcome, side, price_le].
#[account]
#[derive(InitSpace)]
pub struct PredictionPriceLevel {
    pub market: Pubkey,
    pub outcome: PredictionOutcome,
    pub side: OrderSide,
    /// Collateral atoms per whole contract; tick/range checks belong to placement.
    pub price: u64,
    /// Higher matching priority within this outcome and side only:
    /// higher prices for bids, lower prices for asks.
    pub better_price: Option<u64>,
    pub worse_price: Option<u64>,
    /// Oldest open order, consumed first at this price.
    pub first_order: Option<Pubkey>,
    /// Newest open order; subsequent submissions append here.
    pub last_order: Option<Pubkey>,
    /// Whole outcome contracts, including partially filled order remainders.
    pub total_remaining_quantity: u64,
    pub order_count: u64,
    /// Original payer receiving rent when cancellation or matching empties this level.
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// One order submission: ["prediction_order", market, order_id_le].
///
/// IDs are unique across both outcomes and both sides. Outcome is nevertheless
/// stored and must match the supplied level and position bucket on every action.
#[account]
#[derive(InitSpace)]
pub struct PredictionOrder {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub order_id: u64,
    pub outcome: PredictionOutcome,
    pub side: OrderSide,
    pub price: u64,
    pub price_level: Pubkey,
    /// Older/newer open orders at exactly the same outcome, side and price.
    pub previous_order: Option<Pubkey>,
    pub next_order: Option<Pubkey>,
    /// Whole contracts, never mint atoms or fractional positions.
    pub quantity: u64,
    pub remaining_quantity: u64,
    /// Bid: exactly price * remaining_quantity collateral atoms; no maker fee
    /// reserve. Ask: whole YES or NO contracts selected by `outcome`.
    /// Cancellation/fills must release the recorded amount, not guess units.
    pub locked_collateral: u64,
    pub status: OrderStatus,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_root_fits_maximum_heads_and_preserves_empty_sides() {
        // market key + u64 ID + four (tag + u64) Options + bump.
        assert_eq!(PredictionOrderBook::INIT_SPACE, 32 + 8 + 4 * 9 + 1);
        let mut book = PredictionOrderBook {
            market: Pubkey::new_unique(),
            next_order_id: u64::MAX,
            yes_best_bid: Some(10),
            yes_best_ask: Some(20),
            no_best_bid: Some(30),
            no_best_ask: Some(40),
            bump: 254,
        };
        let mut bytes = Vec::new();
        book.try_serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), 8 + 77);
        let decoded = PredictionOrderBook::try_deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(decoded.market, book.market);
        assert_eq!(decoded.next_order_id, u64::MAX);
        assert_eq!(
            [
                decoded.yes_best_bid,
                decoded.yes_best_ask,
                decoded.no_best_bid,
                decoded.no_best_ask
            ],
            [Some(10), Some(20), Some(30), Some(40)]
        );
        assert_eq!(decoded.bump, 254);
        book.yes_best_bid = None;
        book.no_best_ask = None;
        let mut bytes = Vec::new();
        book.try_serialize(&mut bytes).unwrap();
        bytes.resize(8 + PredictionOrderBook::INIT_SPACE, 0);
        let decoded = PredictionOrderBook::try_deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(
            [
                decoded.yes_best_bid,
                decoded.yes_best_ask,
                decoded.no_best_bid,
                decoded.no_best_ask
            ],
            [None, Some(20), Some(30), None]
        );
    }

    #[test]
    fn level_and_order_round_trip_all_outcomes_sides_and_lifecycle_tags() {
        assert_eq!(
            PredictionPriceLevel::INIT_SPACE,
            32 + 1 + 1 + 8 + 2 * 9 + 2 * 33 + 8 + 8 + 32 + 1
        );
        assert_eq!(PredictionPriceLevel::INIT_SPACE, 175);
        assert_eq!(
            PredictionOrder::INIT_SPACE,
            32 + 32 + 8 + 1 + 1 + 8 + 32 + 2 * 33 + 3 * 8 + 1 + 1
        );
        assert_eq!(PredictionOrder::INIT_SPACE, 206);
        for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
            for side in [OrderSide::Bid, OrderSide::Ask] {
                let market = Pubkey::new_unique();
                let level_key = Pubkey::new_unique();
                let first = Pubkey::new_unique();
                let last = Pubkey::new_unique();
                let (better, worse) = match side {
                    OrderSide::Bid => (660_000, 640_000),
                    OrderSide::Ask => (640_000, 660_000),
                };
                let level = PredictionPriceLevel {
                    market,
                    outcome,
                    side,
                    price: 650_000,
                    better_price: Some(better),
                    worse_price: Some(worse),
                    first_order: Some(first),
                    last_order: Some(last),
                    total_remaining_quantity: 9,
                    order_count: 2,
                    rent_payer: Pubkey::new_unique(),
                    bump: 253,
                };
                let mut bytes = Vec::new();
                level.try_serialize(&mut bytes).unwrap();
                assert_eq!(bytes.len(), 8 + 175);
                let decoded = PredictionPriceLevel::try_deserialize(&mut bytes.as_slice()).unwrap();
                assert_eq!(
                    (decoded.market, decoded.outcome, decoded.side, decoded.price),
                    (market, outcome, side, 650_000)
                );
                assert_eq!(
                    (decoded.better_price, decoded.worse_price),
                    (Some(better), Some(worse))
                );
                assert_eq!(
                    (decoded.first_order, decoded.last_order),
                    (Some(first), Some(last))
                );
                assert_eq!(
                    (
                        decoded.total_remaining_quantity,
                        decoded.order_count,
                        decoded.rent_payer,
                        decoded.bump
                    ),
                    (9, 2, level.rent_payer, 253)
                );
                for status in [
                    OrderStatus::Open,
                    OrderStatus::Filled,
                    OrderStatus::Canceled,
                ] {
                    let (previous, next) = if status == OrderStatus::Open {
                        (Some(first), Some(last))
                    } else {
                        (None, None)
                    };
                    let remaining = if status == OrderStatus::Filled { 0 } else { 3 };
                    let locked = if status == OrderStatus::Open {
                        match side {
                            OrderSide::Bid => 1_950_000,
                            OrderSide::Ask => 3,
                        }
                    } else {
                        0
                    };
                    let order = PredictionOrder {
                        owner: Pubkey::new_unique(),
                        market,
                        order_id: u64::MAX,
                        outcome,
                        side,
                        price: 650_000,
                        price_level: level_key,
                        previous_order: previous,
                        next_order: next,
                        quantity: 7,
                        remaining_quantity: remaining,
                        locked_collateral: locked,
                        status,
                        bump: 252,
                    };
                    let mut bytes = Vec::new();
                    order.try_serialize(&mut bytes).unwrap();
                    if status == OrderStatus::Open {
                        assert_eq!(bytes.len(), 8 + 206);
                    } else {
                        assert!(bytes.len() < 8 + 206);
                    }
                    bytes.resize(8 + PredictionOrder::INIT_SPACE, 0);
                    let decoded = PredictionOrder::try_deserialize(&mut bytes.as_slice()).unwrap();
                    assert_eq!(
                        (decoded.owner, decoded.market, decoded.order_id),
                        (order.owner, market, u64::MAX)
                    );
                    assert_eq!(
                        (decoded.outcome, decoded.side, decoded.price),
                        (outcome, side, 650_000)
                    );
                    assert_eq!(
                        (
                            decoded.price_level,
                            decoded.previous_order,
                            decoded.next_order
                        ),
                        (level_key, previous, next)
                    );
                    assert_eq!(
                        (
                            decoded.quantity,
                            decoded.remaining_quantity,
                            decoded.locked_collateral,
                            decoded.status,
                            decoded.bump
                        ),
                        (7, remaining, locked, status, 252)
                    );
                }
            }
        }
    }

    #[test]
    fn optional_queue_links_are_absent_without_zero_key_sentinels() {
        let level = PredictionPriceLevel {
            market: Pubkey::new_unique(),
            outcome: PredictionOutcome::No,
            side: OrderSide::Ask,
            price: 350_000,
            better_price: None,
            worse_price: None,
            first_order: None,
            last_order: None,
            total_remaining_quantity: 0,
            order_count: 0,
            rent_payer: Pubkey::new_unique(),
            bump: 255,
        };
        let mut bytes = Vec::new();
        level.try_serialize(&mut bytes).unwrap();
        bytes.resize(8 + PredictionPriceLevel::INIT_SPACE, 0);
        let decoded = PredictionPriceLevel::try_deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(
            (
                decoded.better_price,
                decoded.worse_price,
                decoded.first_order,
                decoded.last_order
            ),
            (None, None, None, None)
        );
        let order = PredictionOrder {
            owner: Pubkey::new_unique(),
            market: level.market,
            order_id: 1,
            outcome: PredictionOutcome::No,
            side: OrderSide::Ask,
            price: 350_000,
            price_level: Pubkey::new_unique(),
            previous_order: None,
            next_order: None,
            quantity: 3,
            remaining_quantity: 3,
            locked_collateral: 3,
            status: OrderStatus::Open,
            bump: 254,
        };
        let mut bytes = Vec::new();
        order.try_serialize(&mut bytes).unwrap();
        bytes.resize(8 + PredictionOrder::INIT_SPACE, 0);
        let decoded = PredictionOrder::try_deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!((decoded.previous_order, decoded.next_order), (None, None));
        // A spot decoder must reject a prediction order even though the fields
        // look similar; account discriminators keep the settlement models apart.
        assert!(super::super::Order::try_deserialize(&mut bytes.as_slice()).is_err());
        let mut level_bytes = Vec::new();
        level.try_serialize(&mut level_bytes).unwrap();
        assert!(super::super::PriceLevel::try_deserialize(&mut level_bytes.as_slice()).is_err());
    }
}
