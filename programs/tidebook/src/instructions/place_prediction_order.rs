//! Places one fully backed resting order on an empty outcome/side price list.
//!
//! This first path never matches or inserts into an existing list. Rejecting a
//! crossing price prevents a crossed resting book while matching is unfinished.
//! Funding moves only internal free/locked claims; vault tokens and payout
//! reserves do not move. Resting orders incur no taker fee.

use crate::{
    constants::*,
    errors::{balance, prediction},
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(order_id: u64, outcome: PredictionOutcome, side: OrderSide, price: u64)]
pub struct PlacePredictionOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut, seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = market @ prediction::PredictionPositionMarketMismatch,
        has_one = owner @ prediction::PredictionPositionOwnerMismatch)]
    pub position: Box<Account<'info, PredictionPosition>>,
    #[account(mut, seeds = [PREDICTION_BOOK_SEED, market.key().as_ref()], bump = order_book.bump,
        has_one = market @ prediction::PredictionBookMarketMismatch)]
    pub order_book: Box<Account<'info, PredictionOrderBook>>,
    #[account(init, payer = owner, space = 8 + PredictionPriceLevel::INIT_SPACE,
        seeds = [PREDICTION_PRICE_LEVEL_SEED, market.key().as_ref(), outcome.seed(), side.seed(), &price.to_le_bytes()], bump)]
    pub price_level: Box<Account<'info, PredictionPriceLevel>>,
    #[account(init, payer = owner, space = 8 + PredictionOrder::INIT_SPACE,
        seeds = [PREDICTION_ORDER_SEED, market.key().as_ref(), &order_id.to_le_bytes()], bump)]
    pub order: Box<Account<'info, PredictionOrder>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_place_prediction_order(
    ctx: Context<PlacePredictionOrder>,
    order_id: u64,
    outcome: PredictionOutcome,
    side: OrderSide,
    price: u64,
    quantity: u64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
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
    let book = &mut ctx.accounts.order_book;
    require!(
        order_id > 0 && order_id == book.next_order_id,
        prediction::InvalidPredictionOrderId
    );
    require!(
        book.best_price(outcome, side).is_none(),
        prediction::PredictionSideNotEmpty
    );
    let opposite = match side {
        OrderSide::Bid => OrderSide::Ask,
        OrderSide::Ask => OrderSide::Bid,
    };
    if let Some(other_price) = book.best_price(outcome, opposite) {
        require!(
            match side {
                OrderSide::Bid => price < other_price,
                OrderSide::Ask => price > other_price,
            },
            prediction::PredictionOrderWouldCross
        );
    }
    // Compute counters before touching claims; checked arithmetic is required
    // even when the browser preflight reported enough cash or contracts.
    let next_id = order_id
        .checked_add(1)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let count = market
        .open_order_count
        .checked_add(1)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let position = &mut ctx.accounts.position;
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
    let order_key = ctx.accounts.order.key();
    let market_key = market.key();
    ctx.accounts.price_level.set_inner(PredictionPriceLevel {
        market: market_key,
        outcome,
        side,
        price,
        better_price: None,
        worse_price: None,
        first_order: Some(order_key),
        last_order: Some(order_key),
        total_remaining_quantity: quantity,
        order_count: 1,
        rent_payer: ctx.accounts.owner.key(),
        bump: ctx.bumps.price_level,
    });
    ctx.accounts.order.set_inner(PredictionOrder {
        owner: ctx.accounts.owner.key(),
        market: market_key,
        order_id,
        outcome,
        side,
        price,
        price_level: ctx.accounts.price_level.key(),
        previous_order: None,
        next_order: None,
        quantity,
        remaining_quantity: quantity,
        locked_collateral: amount,
        status: OrderStatus::Open,
        bump: ctx.bumps.order,
    });
    book.set_best_price(outcome, side, Some(price));
    book.next_order_id = next_id;
    market.open_order_count = count;
    Ok(())
}
