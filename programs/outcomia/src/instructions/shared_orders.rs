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
    rules::trading_open(&ctx.accounts.book, &ctx.accounts.market.to_account_info())?;
    let accounts = &mut *ctx.accounts;
    place_order(
        &mut PlaceAccounts {
            owner: accounts.owner.key(),
            book: &mut accounts.book,
            base_balance: &mut accounts.base_balance,
            quote_balance: &mut accounts.quote_balance,
            position: &mut accounts.position,
            order: &mut accounts.order,
            order_bump: ctx.bumps.order,
            price_level: &mut accounts.price_level,
            price_level_bump: ctx.bumps.price_level,
            tail: &mut accounts.tail,
            better_level: &mut accounts.better_level,
            worse_level: &mut accounts.worse_level,
        },
        outcome,
        side,
        price,
        quantity,
        order_id,
    )
}

/// Validated accounts of one placement, independent of the book's namespace.
/// The caller has already checked that the book's market is trading.
pub(crate) struct PlaceAccounts<'a, 'info> {
    pub owner: Pubkey,
    pub book: &'a mut Box<Account<'info, SharedBook>>,
    pub base_balance: &'a mut Option<Box<Account<'info, AssetBalance>>>,
    pub quote_balance: &'a mut Box<Account<'info, AssetBalance>>,
    pub position: &'a mut Option<Box<Account<'info, PredictionPosition>>>,
    pub order: &'a mut Box<Account<'info, SharedOrder>>,
    pub order_bump: u8,
    pub price_level: &'a mut Box<Account<'info, SharedPriceLevel>>,
    pub price_level_bump: u8,
    pub tail: &'a mut Option<Box<Account<'info, SharedOrder>>>,
    pub better_level: &'a mut Option<Box<Account<'info, SharedPriceLevel>>>,
    pub worse_level: &'a mut Option<Box<Account<'info, SharedPriceLevel>>>,
}

/// Placement shared by public and club books; see [`handle_place_shared_order`].
pub(crate) fn place_order(
    a: &mut PlaceAccounts,
    outcome: SharedOutcome,
    side: OrderSide,
    price: u64,
    quantity: u64,
    order_id: u64,
) -> Result<()> {
    let book = &mut *a.book;
    rules::trader(
        book,
        a.owner,
        a.base_balance.as_deref(),
        a.quote_balance,
        a.position.as_deref(),
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
    // A resting order must not cross through the complete set either; the
    // client matches that liquidity with match_shared_complement first.
    require!(
        !rules::crosses_complement(book, slot, side, price),
        order::InvalidPrice
    );
    let next_id = order_id.checked_add(1).ok_or(order::OrderIdOverflow)?;
    let next_count = book
        .open_order_count
        .checked_add(1)
        .ok_or(shared::InvalidSharedBook)?;
    let key = a.order.key();
    let level = &mut a.price_level;
    let is_new = level.market == Pubkey::default() && level.order_count == 0;
    let (previous, better_price, worse_price, level_count, level_total);
    if !is_new {
        rules::level(level, book)?;
        require!(
            level.outcome == outcome
                && level.side == side
                && level.price == price
                && a.better_level.is_none()
                && a.worse_level.is_none(),
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
        let tail = a.tail.as_ref().ok_or(shared::InvalidSharedNeighbor)?;
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
        require!(a.tail.is_none(), shared::InvalidSharedNeighbor);
        let better = a.better_level.as_ref();
        let worse = a.worse_level.as_ref();
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
        let quote: &mut AssetBalance = a.quote_balance;
        rules::lock(&mut quote.free, &mut quote.locked, amount)?;
    } else {
        let (free, locked) = rules::base_buckets(
            book.kind,
            outcome,
            a.base_balance.as_deref_mut(),
            a.position.as_deref_mut(),
        )?;
        rules::lock(free, locked, amount)?;
    }
    if is_new {
        a.price_level.set_inner(SharedPriceLevel {
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
            rent_payer: a.owner,
            bump: a.price_level_bump,
        });
        if let Some(value) = a.better_level.as_mut() {
            value.worse_price = Some(price);
        } else {
            book.best_prices[slot] = Some(price);
        }
        if let Some(value) = a.worse_level.as_mut() {
            value.better_price = Some(price);
        }
    } else {
        a.tail
            .as_mut()
            .ok_or(shared::InvalidSharedNeighbor)?
            .next_order = Some(key);
        a.price_level.last_order = Some(key);
        a.price_level.order_count = level_count;
        a.price_level.total_remaining_quantity = level_total;
    }
    a.order.set_inner(SharedOrder {
        owner: a.owner,
        market: book.market,
        book: book.key(),
        order_id,
        outcome,
        side,
        price,
        price_level: a.price_level.key(),
        previous_order: previous,
        next_order: None,
        quantity,
        remaining_quantity: quantity,
        locked_collateral: amount,
        status: OrderStatus::Open,
        bump: a.order_bump,
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
    let accounts = &mut *ctx.accounts;
    cancel_order(&mut CancelAccounts {
        owner: accounts.owner.key(),
        book: &mut accounts.book,
        base_balance: &mut accounts.base_balance,
        quote_balance: &mut accounts.quote_balance,
        position: &mut accounts.position,
        order: &mut accounts.order,
        price_level: &mut accounts.price_level,
        previous_order: &mut accounts.previous_order,
        next_order: &mut accounts.next_order,
        better_level: &mut accounts.better_level,
        worse_level: &mut accounts.worse_level,
        level_rent_recipient: &accounts.level_rent_recipient,
    })
}

/// Validated accounts of one cancellation. `owner` is the order's owner, whose
/// claims receive the refund, whoever signed.
pub(crate) struct CancelAccounts<'a, 'info> {
    pub owner: Pubkey,
    pub book: &'a mut Box<Account<'info, SharedBook>>,
    pub base_balance: &'a mut Option<Box<Account<'info, AssetBalance>>>,
    pub quote_balance: &'a mut Box<Account<'info, AssetBalance>>,
    pub position: &'a mut Option<Box<Account<'info, PredictionPosition>>>,
    pub order: &'a mut Box<Account<'info, SharedOrder>>,
    pub price_level: &'a mut Box<Account<'info, SharedPriceLevel>>,
    pub previous_order: &'a mut Option<Box<Account<'info, SharedOrder>>>,
    pub next_order: &'a mut Option<Box<Account<'info, SharedOrder>>>,
    pub better_level: &'a mut Option<Box<Account<'info, SharedPriceLevel>>>,
    pub worse_level: &'a mut Option<Box<Account<'info, SharedPriceLevel>>>,
    pub level_rent_recipient: &'a Option<UncheckedAccount<'info>>,
}

/// Cancellation shared by public and club books; see [`handle_cancel_shared_order`].
pub(crate) fn cancel_order(a: &mut CancelAccounts) -> Result<()> {
    let book = &mut *a.book;
    rules::trader(
        book,
        a.owner,
        a.base_balance.as_deref(),
        a.quote_balance,
        a.position.as_deref(),
    )?;
    rules::order(a.order, book)?;
    let amount = a.order.locked_collateral;
    let (free, locked) = if a.order.side == OrderSide::Bid {
        let q: &mut AssetBalance = a.quote_balance;
        (&mut q.free, &mut q.locked)
    } else {
        rules::base_buckets(
            book.kind,
            a.order.outcome,
            a.base_balance.as_deref_mut(),
            a.position.as_deref_mut(),
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
        a.order,
        a.price_level,
        a.previous_order.as_deref_mut(),
        a.next_order.as_deref_mut(),
        a.better_level.as_deref_mut(),
        a.worse_level.as_deref_mut(),
        a.level_rent_recipient.as_ref(),
    )?;
    *free = new_free;
    *locked = new_locked;
    a.order.status = OrderStatus::Canceled;
    a.order.locked_collateral = 0;
    a.order.previous_order = None;
    a.order.next_order = None;
    Ok(())
}
