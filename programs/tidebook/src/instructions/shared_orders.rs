//! Global-wallet order placement and owner cancellation for spot and prediction books.
//! One insertion entrypoint covers empty sides, sorted prices and same-price FIFO append.
use crate::{
    constants::*,
    errors::{balance, order, shared},
    shared_trading as rules,
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(outcome: SharedOutcome, side: OrderSide, price: u64, quantity: u64, order_id: u64)]
pub struct PlaceSharedOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Canonical spot/prediction market and trading status are checked by the handler.
    #[account(owner = crate::ID)]
    pub market: UncheckedAccount<'info>,
    #[account(mut, seeds = [SHARED_BOOK_SEED, market.key().as_ref()], bump = book.bump,
        has_one = market @ shared::InvalidSharedBook)]
    pub book: Box<Account<'info, SharedBook>>,
    #[account(mut)]
    pub base_balance: Option<Box<Account<'info, AssetBalance>>>,
    #[account(mut)]
    pub quote_balance: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub position: Option<Box<Account<'info, PredictionPosition>>>,
    #[account(init, payer = owner, space = 8 + SharedOrder::INIT_SPACE,
        seeds = [SHARED_ORDER_SEED, book.key().as_ref(), &order_id.to_le_bytes()], bump)]
    pub order: Box<Account<'info, SharedOrder>>,
    #[account(init_if_needed, payer = owner, space = 8 + SharedPriceLevel::INIT_SPACE,
        seeds = [SHARED_LEVEL_SEED, book.key().as_ref(), outcome.seed(), side.seed(), &price.to_le_bytes()], bump)]
    pub price_level: Box<Account<'info, SharedPriceLevel>>,
    #[account(mut)]
    pub tail: Option<Box<Account<'info, SharedOrder>>>,
    #[account(mut)]
    pub better_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    pub system_program: Program<'info, System>,
}

/// Locks shared cash or owned outcome claims and inserts a noncrossing limit order.
///
/// # Inputs
/// Owner, root/source market, canonical cash/position accounts, fresh order, existing/new price
/// level and exact adjacency/FIFO hints; outcome, side, raw price/quantity and next ID.
/// # Errors
/// Wrong models/accounts, closed trading, crossing/bad grid, stale hints/ID, funds or overflow.
/// # Returns
/// `Ok(())` with conserved free/locked amounts, FIFO priority and updated root/counts. No SPL CPI.
pub fn handle_place_shared_order(
    ctx: Context<PlaceSharedOrder>,
    outcome: SharedOutcome,
    side: OrderSide,
    price: u64,
    quantity: u64,
    order_id: u64,
) -> Result<()> {
    let book = &mut ctx.accounts.book;
    rules::trading_open(book, &ctx.accounts.market.to_account_info())?;
    rules::trader(
        book,
        ctx.accounts.owner.key(),
        ctx.accounts.base_balance.as_deref(),
        &ctx.accounts.quote_balance,
        ctx.accounts.position.as_deref(),
    )?;
    let (slot, amount) = rules::order_terms(book, outcome, side, price, quantity)?;
    require!(
        order_id > 0 && order_id == book.next_order_id,
        order::InvalidOrderId
    );
    if let Some(opposite) = book.best_prices[slot ^ 1] {
        require!(
            match side {
                OrderSide::Bid => price < opposite,
                OrderSide::Ask => price > opposite,
            },
            order::InvalidPrice
        );
    }
    let next_id = order_id.checked_add(1).ok_or(order::OrderIdOverflow)?;
    let next_count = book
        .open_order_count
        .checked_add(1)
        .ok_or(shared::InvalidSharedBook)?;
    let key = ctx.accounts.order.key();
    let level = &mut ctx.accounts.price_level;
    let is_new = level.market == Pubkey::default() && level.order_count == 0;
    let (previous, better_price, worse_price, level_count, level_total);
    if !is_new {
        rules::level(level, book)?;
        require!(
            level.outcome == outcome
                && level.side == side
                && level.price == price
                && ctx.accounts.better_level.is_none()
                && ctx.accounts.worse_level.is_none(),
            shared::InvalidSharedNeighbor
        );
        let best = book.best_prices[slot].ok_or(shared::InvalidSharedBook)?;
        require!(
            (level.better_price.is_none()) == (best == price)
                && match side {
                    OrderSide::Bid => best >= price,
                    OrderSide::Ask => best <= price,
                },
            shared::InvalidSharedNeighbor
        );
        let tail = ctx
            .accounts
            .tail
            .as_ref()
            .ok_or(shared::InvalidSharedNeighbor)?;
        rules::order(tail, book)?;
        require!(
            level.last_order == Some(tail.key())
                && tail.price_level == level.key()
                && tail.outcome == outcome
                && tail.side == side
                && tail.price == price
                && tail.next_order.is_none(),
            shared::InvalidSharedNeighbor
        );
        require!(
            if level.order_count == 1 {
                level.first_order == Some(tail.key())
                    && tail.previous_order.is_none()
                    && level.total_remaining_quantity == tail.remaining_quantity
            } else {
                level.first_order != Some(tail.key())
                    && tail.previous_order.is_some()
                    && level.total_remaining_quantity > tail.remaining_quantity
            },
            shared::InvalidSharedNeighbor
        );
        previous = Some(tail.key());
        better_price = level.better_price;
        worse_price = level.worse_price;
        level_count = level
            .order_count
            .checked_add(1)
            .ok_or(shared::InvalidSharedBook)?;
        level_total = level
            .total_remaining_quantity
            .checked_add(quantity)
            .ok_or(shared::InvalidSharedBook)?;
    } else {
        require!(ctx.accounts.tail.is_none(), shared::InvalidSharedNeighbor);
        let better = ctx.accounts.better_level.as_ref();
        let worse = ctx.accounts.worse_level.as_ref();
        for value in [better, worse].into_iter().flatten() {
            rules::level(value, book)?;
            require!(
                value.outcome == outcome && value.side == side,
                shared::InvalidSharedNeighbor
            );
        }
        if let Some(best) = book.best_prices[slot] {
            if let Some(value) = better {
                require!(
                    match side {
                        OrderSide::Bid => value.price > price && best >= value.price,
                        OrderSide::Ask => value.price < price && best <= value.price,
                    },
                    shared::InvalidSharedNeighbor
                );
                require!(
                    value.worse_price == worse.map(|v| v.price),
                    shared::InvalidSharedNeighbor
                );
                require!(
                    (value.better_price.is_none()) == (value.price == best),
                    shared::InvalidSharedNeighbor
                );
            } else {
                let value = worse.ok_or(shared::InvalidSharedNeighbor)?;
                require!(
                    value.price == best && value.better_price.is_none(),
                    shared::InvalidSharedNeighbor
                );
            }
            if let Some(value) = worse {
                require!(
                    value.better_price == better.map(|v| v.price)
                        && match side {
                            OrderSide::Bid => price > value.price,
                            OrderSide::Ask => price < value.price,
                        },
                    shared::InvalidSharedNeighbor
                );
            }
        } else {
            require!(
                better.is_none() && worse.is_none(),
                shared::InvalidSharedNeighbor
            );
        }
        previous = None;
        better_price = better.map(|v| v.price);
        worse_price = worse.map(|v| v.price);
        level_count = 1;
        level_total = quantity;
    }
    if side == OrderSide::Bid {
        let quote: &mut AssetBalance = &mut ctx.accounts.quote_balance;
        rules::lock(&mut quote.free, &mut quote.locked, amount)?;
    } else {
        let (free, locked) = rules::base_buckets(
            book.kind,
            outcome,
            ctx.accounts.base_balance.as_deref_mut(),
            ctx.accounts.position.as_deref_mut(),
        )?;
        rules::lock(free, locked, amount)?;
    }
    if is_new {
        ctx.accounts.price_level.set_inner(SharedPriceLevel {
            book: book.key(),
            market: book.market,
            outcome,
            side,
            price,
            better_price,
            worse_price,
            first_order: Some(key),
            last_order: Some(key),
            total_remaining_quantity: quantity,
            order_count: 1,
            rent_payer: ctx.accounts.owner.key(),
            bump: ctx.bumps.price_level,
        });
        if let Some(value) = ctx.accounts.better_level.as_mut() {
            value.worse_price = Some(price);
        } else {
            book.best_prices[slot] = Some(price);
        }
        if let Some(value) = ctx.accounts.worse_level.as_mut() {
            value.better_price = Some(price);
        }
    } else {
        ctx.accounts
            .tail
            .as_mut()
            .ok_or(shared::InvalidSharedNeighbor)?
            .next_order = Some(key);
        ctx.accounts.price_level.last_order = Some(key);
        ctx.accounts.price_level.order_count = level_count;
        ctx.accounts.price_level.total_remaining_quantity = level_total;
    }
    ctx.accounts.order.set_inner(SharedOrder {
        owner: ctx.accounts.owner.key(),
        market: book.market,
        book: book.key(),
        order_id,
        outcome,
        side,
        price,
        price_level: ctx.accounts.price_level.key(),
        previous_order: previous,
        next_order: None,
        quantity,
        remaining_quantity: quantity,
        locked_collateral: amount,
        status: OrderStatus::Open,
        bump: ctx.bumps.order,
    });
    book.next_order_id = next_id;
    book.open_order_count = next_count;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelSharedOrder<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [SHARED_BOOK_SEED, book.market.as_ref()], bump = book.bump)]
    pub book: Box<Account<'info, SharedBook>>,
    #[account(mut)]
    pub base_balance: Option<Box<Account<'info, AssetBalance>>>,
    #[account(mut)]
    pub quote_balance: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub position: Option<Box<Account<'info, PredictionPosition>>>,
    #[account(mut, constraint = order.owner == owner.key() @ shared::UnauthorizedSharedOrderOwner)]
    pub order: Box<Account<'info, SharedOrder>>,
    #[account(mut)]
    pub price_level: Box<Account<'info, SharedPriceLevel>>,
    #[account(mut)]
    pub previous_order: Option<Box<Account<'info, SharedOrder>>>,
    #[account(mut)]
    pub next_order: Option<Box<Account<'info, SharedOrder>>>,
    #[account(mut)]
    pub better_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    /// CHECK: Validated against the stored level rent payer, only when closing that level.
    #[account(mut)]
    pub level_rent_recipient: Option<UncheckedAccount<'info>>,
}

/// Releases only the owner's remaining lock, including after close/pause/resolution.
///
/// # Inputs
/// Owner, root/order/level, canonical trader claims and exact removal hints.
/// # Errors
/// Foreign/non-Open order, wrong backing/accounts, stale FIFO/price links, overflow/underflow.
/// # Returns
/// `Ok(())` with free cash/contracts refunded and empty level rent returned to its original payer.
pub fn handle_cancel_shared_order(ctx: Context<CancelSharedOrder>) -> Result<()> {
    let book = &mut ctx.accounts.book;
    rules::trader(
        book,
        ctx.accounts.owner.key(),
        ctx.accounts.base_balance.as_deref(),
        &ctx.accounts.quote_balance,
        ctx.accounts.position.as_deref(),
    )?;
    rules::order(&ctx.accounts.order, book)?;
    let amount = ctx.accounts.order.locked_collateral;
    let (free, locked) = if ctx.accounts.order.side == OrderSide::Bid {
        let q: &mut AssetBalance = &mut ctx.accounts.quote_balance;
        (&mut q.free, &mut q.locked)
    } else {
        rules::base_buckets(
            book.kind,
            ctx.accounts.order.outcome,
            ctx.accounts.base_balance.as_deref_mut(),
            ctx.accounts.position.as_deref_mut(),
        )?
    };
    let new_free = free
        .checked_add(amount)
        .ok_or(balance::FreeBalanceOverflow)?;
    let new_locked = locked
        .checked_sub(amount)
        .ok_or(balance::LockedBalanceUnderflow)?;
    rules::remove_order(
        book,
        &ctx.accounts.order,
        &mut ctx.accounts.price_level,
        ctx.accounts.previous_order.as_deref_mut(),
        ctx.accounts.next_order.as_deref_mut(),
        ctx.accounts.better_level.as_deref_mut(),
        ctx.accounts.worse_level.as_deref_mut(),
        ctx.accounts.level_rent_recipient.as_ref(),
    )?;
    *free = new_free;
    *locked = new_locked;
    ctx.accounts.order.status = OrderStatus::Canceled;
    ctx.accounts.order.locked_collateral = 0;
    ctx.accounts.order.previous_order = None;
    ctx.accounts.order.next_order = None;
    Ok(())
}
