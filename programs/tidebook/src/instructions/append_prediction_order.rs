//! Adds one new order at a price level's FIFO tail without changing price priority.
//!
//! The old tail can belong to another trader. Its owner and collateral stay
//! unchanged; only its next link is written. Canonical seeds, stored identity,
//! level.last_order and the tail's terminal link are all checked independently.
//! No traversal is needed, so append has bounded account/compute requirements.

use crate::{
    constants::*,
    errors::prediction,
    prediction_orders::{lock_resting_funds, validate_resting_order},
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(order_id: u64, outcome: PredictionOutcome, side: OrderSide, price: u64)]
pub struct AppendPredictionOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut, seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump = position.bump,
        has_one = market @ prediction::PredictionPositionMarketMismatch,
        has_one = owner @ prediction::PredictionPositionOwnerMismatch)]
    pub position: Box<Account<'info, PredictionPosition>>,
    #[account(mut, seeds = [PREDICTION_BOOK_SEED, market.key().as_ref()], bump = order_book.bump,
        has_one = market @ prediction::PredictionBookMarketMismatch)]
    pub order_book: Box<Account<'info, PredictionOrderBook>>,
    #[account(mut, seeds = [PREDICTION_PRICE_LEVEL_SEED, market.key().as_ref(), outcome.seed(), side.seed(), &price.to_le_bytes()], bump = price_level.bump,
        has_one = market @ prediction::InvalidPredictionPriceLevel,
        constraint = price_level.outcome == outcome && price_level.side == side && price_level.price == price @ prediction::InvalidPredictionPriceLevel)]
    pub price_level: Box<Account<'info, PredictionPriceLevel>>,
    #[account(mut, seeds = [PREDICTION_ORDER_SEED, market.key().as_ref(), &tail_order.order_id.to_le_bytes()], bump = tail_order.bump)]
    pub tail_order: Box<Account<'info, PredictionOrder>>,
    #[account(init, payer = owner, space = 8 + PredictionOrder::INIT_SPACE,
        seeds = [PREDICTION_ORDER_SEED, market.key().as_ref(), &order_id.to_le_bytes()], bump)]
    pub order: Box<Account<'info, PredictionOrder>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_append_prediction_order(
    ctx: Context<AppendPredictionOrder>,
    order_id: u64,
    outcome: PredictionOutcome,
    side: OrderSide,
    price: u64,
    quantity: u64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let book = &mut ctx.accounts.order_book;
    let (next_id, count) =
        validate_resting_order(market, book, order_id, outcome, side, price, quantity)?;
    let level = &mut ctx.accounts.price_level;
    let tail = &mut ctx.accounts.tail_order;
    let best = book
        .best_price(outcome, side)
        .ok_or(prediction::InvalidPredictionPriceLevel)?;
    // The best level has no better neighbor. Non-best levels must have one;
    // links are program-owned, and append does not edit price-list neighbors.
    require!(
        (best == price) == level.better_price.is_none()
            && match side {
                OrderSide::Bid => best >= price,
                OrderSide::Ask => best <= price,
            },
        prediction::InvalidPredictionPriceLevel
    );
    require!(
        level.order_count > 0
            && level.first_order.is_some()
            && level.last_order == Some(tail.key()),
        prediction::InvalidPredictionTail
    );
    require!(
        tail.market == market.key()
            && tail.price_level == level.key()
            && tail.outcome == outcome
            && tail.side == side
            && tail.price == price
            && tail.status == OrderStatus::Open
            && tail.remaining_quantity > 0
            && tail.remaining_quantity <= tail.quantity
            && tail.next_order.is_none()
            && tail.order_id > 0
            && tail.order_id < order_id,
        prediction::InvalidPredictionTail
    );
    if level.order_count == 1 {
        require!(
            level.first_order == Some(tail.key())
                && tail.previous_order.is_none()
                && level.total_remaining_quantity == tail.remaining_quantity,
            prediction::InvalidPredictionTail
        );
    } else {
        require!(
            level.first_order != Some(tail.key())
                && tail.previous_order.is_some()
                && tail.previous_order != Some(tail.key())
                && level.total_remaining_quantity >= tail.remaining_quantity,
            prediction::InvalidPredictionTail
        );
    }
    let total = level
        .total_remaining_quantity
        .checked_add(quantity)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let level_count = level
        .order_count
        .checked_add(1)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let amount = lock_resting_funds(&mut ctx.accounts.position, outcome, side, price, quantity)?;
    let order_key = ctx.accounts.order.key();
    ctx.accounts.order.set_inner(PredictionOrder {
        owner: ctx.accounts.owner.key(),
        market: market.key(),
        order_id,
        outcome,
        side,
        price,
        price_level: level.key(),
        previous_order: Some(tail.key()),
        next_order: None,
        quantity,
        remaining_quantity: quantity,
        locked_collateral: amount,
        status: OrderStatus::Open,
        bump: ctx.bumps.order,
    });
    tail.next_order = Some(order_key);
    level.last_order = Some(order_key);
    level.total_remaining_quantity = total;
    level.order_count = level_count;
    // first_order, price neighbors, best heads and the level rent payer retain
    // their original values. Only the new trader pays this order account's rent.
    book.next_order_id = next_id;
    market.open_order_count = count;
    Ok(())
}
