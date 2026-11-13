//! Bounded resting placement and permissionless owner exits. Matching is a
//! separate atomic instruction; resting placement cannot cross another order.
use crate::{
    constants::*,
    errors::{admin, balance, multi_outcome as multi, order, shared},
    multi_outcome_trading as rules,
    shared_trading::asset,
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeMultiOutcomeBook<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds=[ADMIN_SEED,authority.key().as_ref()],bump=admin_record.bump,has_one=authority @ admin::UnauthorizedAdmin,constraint=admin_record.status==AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Account<'info, AdminRecord>,
    #[account(seeds=[MULTI_OUTCOME_MARKET_SEED,market.market_id.as_ref()],bump=market.bump,has_one=authority @ admin::UnauthorizedAdmin)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(init,payer=authority,space=8+MultiOutcomeBook::INIT_SPACE,seeds=[MULTI_OUTCOME_BOOK_SEED,market.key().as_ref()],bump)]
    pub book: Box<Account<'info, MultiOutcomeBook>>,
    pub system_program: Program<'info, System>,
}
/// Inputs: active-admin creator and canonical unexpired Draft/Open market.
/// Errors: role, duplicate root, lifecycle or nonzero orphaned order count.
/// Returns: empty bounded book; IDs never reset through an update instruction.
pub fn handle_initialize_multi_outcome_book(
    ctx: Context<InitializeMultiOutcomeBook>,
) -> Result<()> {
    let m = &ctx.accounts.market;
    require!(
        matches!(m.status, PredictionStatus::Draft | PredictionStatus::Open)
            && Clock::get()?.unix_timestamp < m.terms.close_ts
            && m.open_order_count == 0,
        multi::InvalidMultiOutcomeBook
    );
    ctx.accounts.book.set_inner(MultiOutcomeBook {
        market: m.key(),
        authority: ctx.accounts.authority.key(),
        orders: Vec::new(),
        next_order_id: 1,
        accrued_collateral_fees: 0,
        bump: ctx.bumps.book,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(outcome:OutcomeId,side:OrderSide,price:u64,quantity:u64,order_id:u64)]
pub struct PlaceMultiOutcomeOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut,seeds=[MULTI_OUTCOME_MARKET_SEED,market.market_id.as_ref()],bump=market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(mut,seeds=[MULTI_OUTCOME_BOOK_SEED,market.key().as_ref()],bump=book.bump,has_one=market @ multi::InvalidMultiOutcomeBook)]
    pub book: Box<Account<'info, MultiOutcomeBook>>,
    #[account(mut,seeds=[ASSET_BALANCE_SEED,owner.key().as_ref(),market.collateral_mint.as_ref()],bump=cash.bump)]
    pub cash: Account<'info, AssetBalance>,
    #[account(mut,seeds=[MULTI_OUTCOME_POSITION_SEED,market.key().as_ref(),owner.key().as_ref()],bump=position.bump)]
    pub position: Account<'info, MultiOutcomePosition>,
    #[account(init,payer=owner,space=8+MultiOutcomeOrder::INIT_SPACE,seeds=[MULTI_OUTCOME_ORDER_SEED,book.key().as_ref(),&order_id.to_le_bytes()],bump)]
    pub order: Account<'info, MultiOutcomeOrder>,
    pub system_program: Program<'info, System>,
}
/// Inputs: owner, canonical claims/book and next ID plus exact order units.
/// Errors: closed book, crossing, capacity, bad grid, stale ID, insufficient
/// free assets or overflow. Returns: exclusive funded maker escrow and FIFO ID.
pub fn handle_place_multi_outcome_order(
    ctx: Context<PlaceMultiOutcomeOrder>,
    outcome: OutcomeId,
    side: OrderSide,
    price: u64,
    quantity: u64,
    order_id: u64,
) -> Result<()> {
    let e = rules::book_terms(&ctx.accounts.market, &ctx.accounts.book, true)?;
    let amount = rules::notional(e, outcome, price, quantity)?;
    asset(
        &ctx.accounts.cash,
        ctx.accounts.owner.key(),
        ctx.accounts.market.collateral_mint,
    )?;
    rules::position(
        &ctx.accounts.market,
        &ctx.accounts.position,
        ctx.accounts.owner.key(),
        ctx.accounts.market.key(),
    )?;
    require!(
        ctx.accounts.book.orders.len() < MULTI_OUTCOME_MAX_ORDERS,
        multi::MultiOutcomeBookFull
    );
    require!(
        order_id == ctx.accounts.book.next_order_id && order_id > 0,
        order::InvalidOrderId
    );
    let opposite = if side == OrderSide::Bid {
        OrderSide::Ask
    } else {
        OrderSide::Bid
    };
    if let Some(r) = rules::best(&ctx.accounts.book, outcome, opposite) {
        require!(
            if side == OrderSide::Bid {
                price < r.price
            } else {
                price > r.price
            },
            order::InvalidPrice
        );
    }
    let next = order_id.checked_add(1).ok_or(order::OrderIdOverflow)?;
    let i = usize::from(outcome.index());
    let lock = if side == OrderSide::Bid {
        amount
    } else {
        quantity
    };
    if side == OrderSide::Bid {
        let cash: &mut AssetBalance = &mut ctx.accounts.cash;
        crate::shared_trading::lock(&mut cash.free, &mut cash.locked, lock)?;
    } else {
        let p = &mut ctx.accounts.position;
        let free = p.free[i]
            .checked_sub(lock)
            .ok_or(balance::InsufficientFreeBalance)?;
        let locked = p.locked[i]
            .checked_add(lock)
            .ok_or(balance::LockedBalanceOverflow)?;
        p.free[i] = free;
        p.locked[i] = locked;
    }
    ctx.accounts.order.set_inner(MultiOutcomeOrder {
        owner: ctx.accounts.owner.key(),
        market: ctx.accounts.market.key(),
        book: ctx.accounts.book.key(),
        order_id,
        outcome,
        side,
        price,
        quantity,
        remaining_quantity: quantity,
        locked_amount: lock,
        status: OrderStatus::Open,
        bump: ctx.bumps.order,
    });
    ctx.accounts.book.orders.push(MultiOutcomeOrderReference {
        order: ctx.accounts.order.key(),
        order_id,
        outcome,
        side,
        price,
    });
    ctx.accounts.book.next_order_id = next;
    ctx.accounts.market.open_order_count = ctx.accounts.book.orders.len() as u64;
    emit!(crate::MultiOutcomeOrderEvent {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        order: ctx.accounts.order.key(),
        outcome,
        side,
        price,
        quantity,
        status: OrderStatus::Open
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelMultiOutcomeOrder<'info> {
    pub owner: Signer<'info>,
    #[account(mut,seeds=[MULTI_OUTCOME_MARKET_SEED,market.market_id.as_ref()],bump=market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(mut,seeds=[MULTI_OUTCOME_BOOK_SEED,market.key().as_ref()],bump=book.bump,has_one=market @ multi::InvalidMultiOutcomeBook)]
    pub book: Box<Account<'info, MultiOutcomeBook>>,
    #[account(mut,seeds=[MULTI_OUTCOME_ORDER_SEED,book.key().as_ref(),&order.order_id.to_le_bytes()],bump=order.bump,has_one=owner @ shared::UnauthorizedSharedOrderOwner,has_one=market @ multi::InvalidMultiOutcomeBook,has_one=book @ multi::InvalidMultiOutcomeBook)]
    pub order: Account<'info, MultiOutcomeOrder>,
    #[account(mut,seeds=[ASSET_BALANCE_SEED,owner.key().as_ref(),market.collateral_mint.as_ref()],bump=cash.bump)]
    pub cash: Account<'info, AssetBalance>,
    #[account(mut,seeds=[MULTI_OUTCOME_POSITION_SEED,market.key().as_ref(),owner.key().as_ref()],bump=position.bump)]
    pub position: Account<'info, MultiOutcomePosition>,
}
/// Inputs: order owner and canonical current book/claims. Errors: foreign or
/// replayed order, invalid index/backing or overflow. Returns: only this order's
/// remaining lock to free; works after cutoff, freeze, resolution or admin removal.
pub fn handle_cancel_multi_outcome_order(ctx: Context<CancelMultiOutcomeOrder>) -> Result<()> {
    let economics = rules::book_terms(&ctx.accounts.market, &ctx.accounts.book, false)?;
    asset(
        &ctx.accounts.cash,
        ctx.accounts.owner.key(),
        ctx.accounts.market.collateral_mint,
    )?;
    rules::position(
        &ctx.accounts.market,
        &ctx.accounts.position,
        ctx.accounts.owner.key(),
        ctx.accounts.market.key(),
    )?;
    let index = rules::order_index(
        &ctx.accounts.book,
        economics,
        ctx.accounts.order.key(),
        &ctx.accounts.order,
    )?;
    let o = &ctx.accounts.order;
    let q = o.remaining_quantity;
    if o.side == OrderSide::Bid {
        let b = &mut ctx.accounts.cash;
        b.locked = b
            .locked
            .checked_sub(o.locked_amount)
            .ok_or(balance::LockedBalanceUnderflow)?;
        b.free = b
            .free
            .checked_add(o.locked_amount)
            .ok_or(balance::FreeBalanceOverflow)?;
    } else {
        let i = usize::from(o.outcome.index());
        let p = &mut ctx.accounts.position;
        p.locked[i] = p.locked[i]
            .checked_sub(o.locked_amount)
            .ok_or(balance::LockedBalanceUnderflow)?;
        p.free[i] = p.free[i]
            .checked_add(o.locked_amount)
            .ok_or(balance::FreeBalanceOverflow)?;
    }
    ctx.accounts.book.orders.remove(index);
    ctx.accounts.market.open_order_count = ctx.accounts.book.orders.len() as u64;
    let o = &mut ctx.accounts.order;
    o.remaining_quantity = 0;
    o.locked_amount = 0;
    o.status = OrderStatus::Canceled;
    emit!(crate::MultiOutcomeOrderEvent {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        order: o.key(),
        outcome: o.outcome,
        side: o.side,
        price: o.price,
        quantity: q,
        status: OrderStatus::Canceled
    });
    Ok(())
}
