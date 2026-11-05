//! Shared resting-order rules for empty placement, FIFO append and price insertion.
//! Account/PDA and queue validation stay in each instruction's context/handler.

use crate::{
    errors::{balance, prediction},
    state::*,
};
use anchor_lang::prelude::*;

/// Validate trading terms and return the checked next ID and market count.
///
/// # Inputs
/// Market/book snapshots, expected current order ID, outcome, side, collateral-atom price and whole
/// quantity; reads chain Clock.
///
/// # Errors
/// Closed/expired trading, zero quantity, off-grid/out-of-range/crossing price, stale ID or counter
/// overflow.
///
/// # Returns
/// `Ok((next_id, open_count))`; callers still validate PDAs/links and fund the order before
/// publishing either counter.
pub(crate) fn validate_resting_order(
    market: &PredictionMarket,
    book: &PredictionOrderBook,
    order_id: u64,
    outcome: PredictionOutcome,
    side: OrderSide,
    price: u64,
    quantity: u64,
) -> Result<(u64, u64)> {
    require!(
        market.status == PredictionStatus::Open && Clock::get()?.unix_timestamp < market.close_ts,
        prediction::PredictionOrderUnavailable
    );
    require!(quantity > 0, prediction::InvalidPredictionContractQuantity);
    require!(
        price > 0 && price < market.payout_per_contract && market.price_tick > 0,
        prediction::InvalidPredictionOrderPrice
    );
    require!(
        price.is_multiple_of(market.price_tick),
        prediction::InvalidPredictionOrderPrice
    );
    require!(
        order_id > 0 && order_id == book.next_order_id,
        prediction::InvalidPredictionOrderId
    );
    let opposite = match side {
        OrderSide::Bid => OrderSide::Ask,
        OrderSide::Ask => OrderSide::Bid,
    };
    if let Some(other) = book.best_price(outcome, opposite) {
        require!(
            match side {
                OrderSide::Bid => price < other,
                OrderSide::Ask => price > other,
            },
            prediction::PredictionOrderWouldCross
        );
    }
    Ok((
        book.next_order_id
            .checked_add(1)
            .ok_or(prediction::PredictionAccountingOverflow)?,
        market
            .open_order_count
            .checked_add(1)
            .ok_or(prediction::PredictionAccountingOverflow)?,
    ))
}

/// Only the new owner's claims move; the maker at the old tail never signs.
///
/// Example with six-decimal collateral: a buy of 10 contracts at raw price
/// 600,000 locks 6,000,000 atoms (6 tokens). A sell of 10 YES locks 10 YES,
/// not 6 collateral tokens. Whole contracts need no base-decimal division.
/// Free + locked for that bucket is conserved; reserve and vault are untouched.
///
/// # Inputs
/// Mutable position, chosen outcome/side, collateral-atom price and whole-contract quantity.
///
/// # Errors
/// Not enough free cash/contracts, price-times-quantity overflow or locked-balance overflow.
///
/// # Returns
/// `Ok(locked_amount)` in collateral atoms for bids or whole chosen contracts for asks; no vault
/// transfer or fee.
pub(crate) fn lock_resting_funds(
    position: &mut PredictionPosition,
    outcome: PredictionOutcome,
    side: OrderSide,
    price: u64,
    quantity: u64,
) -> Result<u64> {
    let (free, locked, amount) = match (outcome, side) {
        (_, OrderSide::Bid) => (
            position.collateral_free,
            position.collateral_locked,
            price
                .checked_mul(quantity)
                .ok_or(prediction::PredictionAccountingOverflow)?,
        ),
        (PredictionOutcome::Yes, OrderSide::Ask) => {
            (position.yes_free, position.yes_locked, quantity)
        }
        (PredictionOutcome::No, OrderSide::Ask) => (position.no_free, position.no_locked, quantity),
    };
    let next_free = free.checked_sub(amount).ok_or(match side {
        OrderSide::Bid => error!(balance::InsufficientFreeBalance),
        OrderSide::Ask => error!(prediction::InsufficientPredictionPositions),
    })?;
    let next_locked = locked
        .checked_add(amount)
        .ok_or(balance::LockedBalanceOverflow)?;
    match (outcome, side) {
        (_, OrderSide::Bid) => {
            position.collateral_free = next_free;
            position.collateral_locked = next_locked;
        }
        (PredictionOutcome::Yes, OrderSide::Ask) => {
            position.yes_free = next_free;
            position.yes_locked = next_locked;
        }
        (PredictionOutcome::No, OrderSide::Ask) => {
            position.no_free = next_free;
            position.no_locked = next_locked;
        }
    }
    Ok(amount)
}
