//! Splices a new price and its first FIFO order into an occupied prediction side.
//!
//! The client discovers neighbors off-chain. Canonical accounts and reciprocal
//! links prove adjacency; accepting merely sorted hints could detach intervening
//! levels. Only those two neighbors are writable, keeping on-chain work O(1).
//! Concurrent insertion makes old hints fail atomically, including account rent
//! and balance changes. Existing prices use append instead of resetting a queue.

use crate::{
    constants::*,
    errors::prediction,
    pda::derive_prediction_price_level_pda,
    prediction_orders::{lock_resting_funds, validate_resting_order},
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(order_id: u64, outcome: PredictionOutcome, side: OrderSide, price: u64)]
pub struct InsertPredictionOrder<'info> {
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
    #[account(init, payer = owner, space = 8 + PredictionPriceLevel::INIT_SPACE,
        seeds = [PREDICTION_PRICE_LEVEL_SEED, market.key().as_ref(), outcome.seed(), side.seed(), &price.to_le_bytes()], bump)]
    pub price_level: Box<Account<'info, PredictionPriceLevel>>,
    #[account(init, payer = owner, space = 8 + PredictionOrder::INIT_SPACE,
        seeds = [PREDICTION_ORDER_SEED, market.key().as_ref(), &order_id.to_le_bytes()], bump)]
    pub order: Box<Account<'info, PredictionOrder>>,
    pub system_program: Program<'info, System>,
    /// Higher-priority adjacent price, absent only when inserting a new best.
    #[account(mut)]
    pub better_level: Option<Box<Account<'info, PredictionPriceLevel>>>,
    /// Lower-priority adjacent price, absent only when inserting a new worst.
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, PredictionPriceLevel>>>,
}

/// Splices a new prediction price between verified neighbors.
///
/// # Inputs
/// `ctx`: trader/position, market/book, new order/level and adjacent hints; ID, outcome, side,
/// price and whole quantity.
///
/// # Errors
/// Closed trading, crossing/bad price, stale ID/adjacency, wrong namespace, empty-side misuse,
/// insufficient funds or overflow.
///
/// # Returns
/// `Ok(())` after a funded best/middle/worst splice; same-price submissions must append.
pub fn handle_insert_prediction_order(
    ctx: Context<InsertPredictionOrder>,
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
    let best = book
        .best_price(outcome, side)
        .ok_or(prediction::InvalidPredictionPriceLevel)?;
    let better = ctx.accounts.better_level.as_ref();
    let worse = ctx.accounts.worse_level.as_ref();
    for level in [better, worse].into_iter().flatten() {
        validate_neighbor(level, market.key(), outcome, side, best)?;
    }
    let precedes = |a, b| match side {
        OrderSide::Bid => a > b,
        OrderSide::Ask => a < b,
    };
    // Bid example: inserting 0.65 between 0.70 and 0.60 requires those exact
    // adjacent links in both directions. Merely supplying prices above/below
    // the target could detach a hidden 0.66 level. Asks reverse the inequalities.
    let valid = match (better, worse) {
        (None, Some(worse)) => {
            worse.price == best && worse.better_price.is_none() && precedes(price, worse.price)
        }
        (Some(better), Some(worse)) => {
            better.worse_price == Some(worse.price)
                && worse.better_price == Some(better.price)
                && precedes(better.price, price)
                && precedes(price, worse.price)
        }
        (Some(better), None) => better.worse_price.is_none() && precedes(better.price, price),
        (None, None) => false,
    };
    require!(valid, prediction::InvalidPredictionPriceLevel);
    let better_price = better.map(|level| level.price);
    let worse_price = worse.map(|level| level.price);
    let amount = lock_resting_funds(&mut ctx.accounts.position, outcome, side, price, quantity)?;
    // Rewire after every check. These writes and the funding debit commit or
    // roll back together; no empty active level can escape this instruction.
    if let Some(level) = ctx.accounts.better_level.as_mut() {
        level.worse_price = Some(price);
    }
    if let Some(level) = ctx.accounts.worse_level.as_mut() {
        level.better_price = Some(price);
    }
    let order_key = ctx.accounts.order.key();
    ctx.accounts.price_level.set_inner(PredictionPriceLevel {
        market: market.key(),
        outcome,
        side,
        price,
        better_price,
        worse_price,
        first_order: Some(order_key),
        last_order: Some(order_key),
        total_remaining_quantity: quantity,
        order_count: 1,
        rent_payer: ctx.accounts.owner.key(),
        bump: ctx.bumps.price_level,
    });
    ctx.accounts.order.set_inner(PredictionOrder {
        owner: ctx.accounts.owner.key(),
        market: market.key(),
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
    if better_price.is_none() {
        book.set_best_price(outcome, side, Some(price));
    }
    book.next_order_id = next_id;
    market.open_order_count = count;
    Ok(())
}

/// Ownership alone is insufficient: bind each hint to this outcome/side PDA.
/// Program-owned links are trusted inductively; traversal stays off-chain.
///
/// # Inputs
/// Program-owned level, expected market/outcome/side and selected book's best price.
///
/// # Errors
/// `InvalidPredictionPriceLevel` for bad PDA/bump/identity, empty queue or head/priority mismatch.
///
/// # Returns
/// `Ok(())` for an eligible live level; the insertion handler separately checks reciprocal
/// adjacency.
fn validate_neighbor(
    level: &Account<PredictionPriceLevel>,
    market: Pubkey,
    outcome: PredictionOutcome,
    side: OrderSide,
    best: u64,
) -> Result<()> {
    let (expected, bump) =
        derive_prediction_price_level_pda(&crate::ID, &market, outcome, side, level.price);
    require!(
        level.key() == expected
            && level.bump == bump
            && level.market == market
            && level.outcome == outcome
            && level.side == side
            && level.order_count > 0
            && level.total_remaining_quantity > 0
            && level.first_order.is_some()
            && level.last_order.is_some()
            && (level.price == best) == level.better_price.is_none()
            && match side {
                OrderSide::Bid => best >= level.price,
                OrderSide::Ask => best <= level.price,
            },
        prediction::InvalidPredictionPriceLevel
    );
    Ok(())
}
