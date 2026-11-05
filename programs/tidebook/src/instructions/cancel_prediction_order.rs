//! Owner-only cancellation repairs the FIFO and, when empty, its price list.
//!
//! No market-status or Clock gate: stopping trading must never trap an owner's
//! unfilled claims. This instruction moves no vault tokens or payout reserve.
//! Clients supply immediate neighbors, checked against canonical addresses and
//! reciprocal links. Work stays bounded even when a book has many orders.
//! Orders remain as canceled history; empty levels close so their price can be
//! reused. Level rent belongs to its original payer, not the last canceler.
//!
//! Example: a 10-contract bid at 0.60 originally locks 6 collateral tokens.
//! After 4 contracts trade, cancellation returns only the 3.6 tokens backing
//! the other 6 contracts. It does not repay the already executed 2.4 tokens.
//! For an ask, the corresponding refund is 6 remaining YES or NO contracts.

use crate::{
    constants::*,
    errors::{balance, prediction},
    pda::{derive_prediction_order_pda, derive_prediction_price_level_pda},
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(order_id: u64)]
pub struct CancelPredictionOrder<'info> {
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
    #[account(mut, seeds = [PREDICTION_ORDER_SEED, market.key().as_ref(), &order_id.to_le_bytes()], bump = order.bump,
        has_one = owner @ prediction::UnauthorizedPredictionOrderOwner,
        has_one = market @ prediction::PredictionPositionMarketMismatch)]
    pub order: Box<Account<'info, PredictionOrder>>,
    #[account(mut, seeds = [PREDICTION_PRICE_LEVEL_SEED, market.key().as_ref(), order.outcome.seed(), order.side.seed(), &order.price.to_le_bytes()], bump = price_level.bump,
        constraint = order.price_level == price_level.key() @ prediction::InvalidPredictionPriceLevel,
        has_one = market @ prediction::InvalidPredictionPriceLevel,
        constraint = price_level.outcome == order.outcome && price_level.side == order.side && price_level.price == order.price @ prediction::InvalidPredictionPriceLevel)]
    pub price_level: Box<Account<'info, PredictionPriceLevel>>,
    #[account(mut)]
    pub previous_order: Option<Box<Account<'info, PredictionOrder>>>,
    #[account(mut)]
    pub next_order: Option<Box<Account<'info, PredictionOrder>>>,
    /// Only supplied when the final order removes its price level.
    #[account(mut)]
    pub better_level: Option<Box<Account<'info, PredictionPriceLevel>>>,
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, PredictionPriceLevel>>>,
    /// CHECK: Required to equal price_level.rent_payer before closing that level.
    #[account(mut)]
    pub level_rent_recipient: Option<UncheckedAccount<'info>>,
}

/// Cancels an owner's unfilled prediction order.
///
/// # Inputs
/// `ctx`: owner, position/book/order/level, FIFO hints and final-level price/rent hints; existing
/// `order_id`.
///
/// # Errors
/// Foreign/non-Open order, bad backing/counts/links, stale or redundant hints, wrong rent
/// recipient, refund overflow or locked underflow.
///
/// # Returns
/// `Ok(())` after refunding only the remainder and retaining Canceled history; final levels close
/// without a trading-time gate.
pub fn handle_cancel_prediction_order(
    ctx: Context<CancelPredictionOrder>,
    order_id: u64,
) -> Result<()> {
    let order = &ctx.accounts.order;
    require!(
        order.status == OrderStatus::Open,
        prediction::PredictionOrderNotOpen
    );
    let level = &ctx.accounts.price_level;
    let book = &ctx.accounts.order_book;
    require!(
        order_id == order.order_id
            && order_id > 0
            && order_id < book.next_order_id
            && order.remaining_quantity > 0
            && order.remaining_quantity <= order.quantity
            && order.price > 0,
        prediction::PredictionOrderAccountingMismatch
    );
    // Current resting bids reserve exact notional; asks reserve whole contracts.
    // If matching later reserves fees, its recorded-backing contract must also
    // change here. Never infer a refund from the original submitted quantity.
    let expected_lock = match order.side {
        OrderSide::Bid => order
            .price
            .checked_mul(order.remaining_quantity)
            .ok_or(prediction::PredictionOrderAccountingMismatch)?,
        OrderSide::Ask => order.remaining_quantity,
    };
    require!(
        order.locked_collateral == expected_lock,
        prediction::PredictionOrderAccountingMismatch
    );
    let order_key = order.key();
    let previous = ctx.accounts.previous_order.as_ref().map(|o| o.key());
    let next = ctx.accounts.next_order.as_ref().map(|o| o.key());
    require!(
        previous == order.previous_order
            && next == order.next_order
            && previous != Some(order_key)
            && next != Some(order_key),
        prediction::InvalidPredictionOrderNeighbor
    );
    require!(
        (level.first_order == Some(order_key)) == previous.is_none()
            && (level.last_order == Some(order_key)) == next.is_none()
            && level.first_order.is_some()
            && level.last_order.is_some(),
        prediction::InvalidPredictionOrderNeighbor
    );
    for (neighbor, is_previous) in [
        (ctx.accounts.previous_order.as_ref(), true),
        (ctx.accounts.next_order.as_ref(), false),
    ] {
        if let Some(neighbor) = neighbor {
            validate_fifo_neighbor(neighbor, order, is_previous)?;
        }
    }
    let best = book
        .best_price(order.outcome, order.side)
        .ok_or(prediction::InvalidPredictionPriceLevel)?;
    require!(
        (best == level.price) == level.better_price.is_none()
            && match order.side {
                OrderSide::Bid => best >= level.price,
                OrderSide::Ask => best <= level.price,
            },
        prediction::InvalidPredictionPriceLevel
    );
    let level_count = level
        .order_count
        .checked_sub(1)
        .ok_or(prediction::PredictionOrderAccountingMismatch)?;
    let total = level
        .total_remaining_quantity
        .checked_sub(order.remaining_quantity)
        .ok_or(prediction::PredictionOrderAccountingMismatch)?;
    let market_count = ctx
        .accounts
        .market
        .open_order_count
        .checked_sub(1)
        .ok_or(prediction::PredictionOrderAccountingMismatch)?;
    let removes_level = level_count == 0;
    if removes_level {
        require!(
            previous.is_none() && next.is_none() && total == 0,
            prediction::PredictionOrderAccountingMismatch
        );
        let recipient = ctx
            .accounts
            .level_rent_recipient
            .as_ref()
            .ok_or(prediction::InvalidPredictionRentRecipient)?;
        require_keys_eq!(
            recipient.key(),
            level.rent_payer,
            prediction::InvalidPredictionRentRecipient
        );
        let better_key = level.better_price.map(|price| {
            derive_prediction_price_level_pda(
                ctx.program_id,
                &order.market,
                order.outcome,
                order.side,
                price,
            )
            .0
        });
        let worse_key = level.worse_price.map(|price| {
            derive_prediction_price_level_pda(
                ctx.program_id,
                &order.market,
                order.outcome,
                order.side,
                price,
            )
            .0
        });
        require!(
            ctx.accounts.better_level.as_ref().map(|l| l.key()) == better_key
                && ctx.accounts.worse_level.as_ref().map(|l| l.key()) == worse_key,
            prediction::InvalidPredictionPriceLevel
        );
        for (neighbor, is_better) in [
            (ctx.accounts.better_level.as_ref(), true),
            (ctx.accounts.worse_level.as_ref(), false),
        ] {
            if let Some(neighbor) = neighbor {
                validate_price_neighbor(neighbor, level, best, is_better)?;
            }
        }
    } else {
        require!(
            total > 0 && (previous.is_some() || next.is_some()),
            prediction::PredictionOrderAccountingMismatch
        );
        require!(
            ctx.accounts.better_level.is_none()
                && ctx.accounts.worse_level.is_none()
                && ctx.accounts.level_rent_recipient.is_none(),
            prediction::InvalidPredictionPriceLevel
        );
    }
    // Order backing determines this refund, not all of the owner's locked
    // bucket: that bucket may also fund other orders. Free + locked stays
    // constant here; only withdrawal can move these cash claims out of custody.
    let amount = order.locked_collateral;
    let position: &mut PredictionPosition = &mut ctx.accounts.position;
    let (free, locked) = match (order.outcome, order.side) {
        (_, OrderSide::Bid) => (
            &mut position.collateral_free,
            &mut position.collateral_locked,
        ),
        (PredictionOutcome::Yes, OrderSide::Ask) => {
            (&mut position.yes_free, &mut position.yes_locked)
        }
        (PredictionOutcome::No, OrderSide::Ask) => (&mut position.no_free, &mut position.no_locked),
    };
    let new_free = free
        .checked_add(amount)
        .ok_or(balance::FreeBalanceOverflow)?;
    let new_locked = locked
        .checked_sub(amount)
        .ok_or(balance::LockedBalanceUnderflow)?;
    *free = new_free;
    *locked = new_locked;
    // All fallible validation and arithmetic precede the index writes. Solana
    // also rolls back this entire transition if account closing/serialization fails.
    if let Some(neighbor) = ctx.accounts.previous_order.as_mut() {
        neighbor.next_order = next;
    } else {
        ctx.accounts.price_level.first_order = next;
    }
    if let Some(neighbor) = ctx.accounts.next_order.as_mut() {
        neighbor.previous_order = previous;
    } else {
        ctx.accounts.price_level.last_order = previous;
    }
    ctx.accounts.price_level.order_count = level_count;
    ctx.accounts.price_level.total_remaining_quantity = total;
    if removes_level {
        let better_price = ctx.accounts.price_level.better_price;
        let worse_price = ctx.accounts.price_level.worse_price;
        if let Some(neighbor) = ctx.accounts.better_level.as_mut() {
            neighbor.worse_price = worse_price;
        } else {
            ctx.accounts
                .order_book
                .set_best_price(order.outcome, order.side, worse_price);
        }
        if let Some(neighbor) = ctx.accounts.worse_level.as_mut() {
            neighbor.better_price = better_price;
        }
    }
    let order = &mut ctx.accounts.order;
    order.status = OrderStatus::Canceled;
    order.remaining_quantity = 0;
    order.locked_collateral = 0;
    order.previous_order = None;
    order.next_order = None;
    ctx.accounts.market.open_order_count = market_count;
    // Preserve the global ID counter and this order account as history. Only
    // the empty price level's rent is returned, to its recorded payer.
    if removes_level {
        let recipient = ctx
            .accounts
            .level_rent_recipient
            .as_ref()
            .ok_or(prediction::InvalidPredictionRentRecipient)?;
        ctx.accounts
            .price_level
            .close(recipient.to_account_info())?;
    }
    Ok(())
}

/// Validates one immediate prediction FIFO neighbor.
///
/// # Inputs
/// Program-owned neighbor, target order and `previous` flag selecting older/newer direction.
///
/// # Errors
/// `InvalidPredictionOrderNeighbor` for noncanonical identity, wrong queue/status or broken
/// reciprocal/ID ordering.
///
/// # Returns
/// `Ok(())` when this hint can participate in O(1) unlinking; no mutation occurs.
fn validate_fifo_neighbor(
    neighbor: &Account<PredictionOrder>,
    order: &Account<PredictionOrder>,
    previous: bool,
) -> Result<()> {
    let (expected, bump) =
        derive_prediction_order_pda(&crate::ID, &order.market, neighbor.order_id);
    require!(
        neighbor.key() == expected
            && neighbor.bump == bump
            && neighbor.market == order.market
            && neighbor.outcome == order.outcome
            && neighbor.side == order.side
            && neighbor.price == order.price
            && neighbor.price_level == order.price_level
            && neighbor.status == OrderStatus::Open
            && neighbor.remaining_quantity > 0
            && neighbor.remaining_quantity <= neighbor.quantity
            && if previous {
                neighbor.next_order == Some(order.key()) && neighbor.order_id < order.order_id
            } else {
                neighbor.previous_order == Some(order.key()) && neighbor.order_id > order.order_id
            },
        prediction::InvalidPredictionOrderNeighbor
    );
    Ok(())
}

/// Validates one price neighbor for prediction-level removal.
///
/// # Inputs
/// Candidate level, level being removed, book best price and `better` direction flag.
///
/// # Errors
/// `InvalidPredictionPriceLevel` for wrong identity/bump, empty queue, head mismatch or broken
/// priority/reciprocity.
///
/// # Returns
/// `Ok(())` when this immediate hint is eligible for rewiring; the full list is not traversed.
fn validate_price_neighbor(
    neighbor: &Account<PredictionPriceLevel>,
    level: &Account<PredictionPriceLevel>,
    best: u64,
    better: bool,
) -> Result<()> {
    let (expected, bump) = derive_prediction_price_level_pda(
        &crate::ID,
        &level.market,
        level.outcome,
        level.side,
        neighbor.price,
    );
    let precedes = |a, b| match level.side {
        OrderSide::Bid => a > b,
        OrderSide::Ask => a < b,
    };
    require!(
        neighbor.key() == expected
            && neighbor.bump == bump
            && neighbor.market == level.market
            && neighbor.outcome == level.outcome
            && neighbor.side == level.side
            && neighbor.order_count > 0
            && neighbor.total_remaining_quantity > 0
            && neighbor.first_order.is_some()
            && neighbor.last_order.is_some()
            && (best == neighbor.price) == neighbor.better_price.is_none()
            && if better {
                neighbor.worse_price == Some(level.price) && precedes(neighbor.price, level.price)
            } else {
                neighbor.better_price == Some(level.price) && precedes(level.price, neighbor.price)
            },
        prediction::InvalidPredictionPriceLevel
    );
    Ok(())
}
