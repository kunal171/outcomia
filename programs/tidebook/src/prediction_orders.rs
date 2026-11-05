//! Shared resting-order rules, kept identical for empty placement and FIFO append.
//! Account/PDA and queue validation stay in each instruction's context/handler.

use crate::{
    errors::{balance, prediction},
    state::*,
};
use anchor_lang::prelude::*;

/// Validate trading terms and return the checked next ID and market count.
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
