//! One on-chain best-price/FIFO fill. No SPL movement is needed because funded
//! maker escrow, both owners' claims and earned fees settle inside global custody.
use crate::{
    constants::*,
    errors::{balance, fee, matching, multi_outcome as multi},
    fees::calculate_taker_fee,
    multi_outcome_trading as rules,
    shared_trading::asset,
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct MatchMultiOutcomeOrder<'info> {
    pub taker: Signer<'info>,
    #[account(mut,seeds=[MULTI_OUTCOME_MARKET_SEED,market.market_id.as_ref()],bump=market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(mut,seeds=[MULTI_OUTCOME_BOOK_SEED,market.key().as_ref()],bump=book.bump,has_one=market @ multi::InvalidMultiOutcomeBook)]
    pub book: Box<Account<'info, MultiOutcomeBook>>,
    #[account(seeds=[PROTOCOL_CONFIG_SEED],bump=protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut,seeds=[MULTI_OUTCOME_ORDER_SEED,book.key().as_ref(),&maker_order.order_id.to_le_bytes()],bump=maker_order.bump,has_one=market @ multi::InvalidMultiOutcomeBook,has_one=book @ multi::InvalidMultiOutcomeBook)]
    pub maker_order: Account<'info, MultiOutcomeOrder>,
    #[account(mut,seeds=[ASSET_BALANCE_SEED,maker_order.owner.as_ref(),market.collateral_mint.as_ref()],bump=maker_cash.bump)]
    pub maker_cash: Account<'info, AssetBalance>,
    #[account(mut,seeds=[MULTI_OUTCOME_POSITION_SEED,market.key().as_ref(),maker_order.owner.as_ref()],bump=maker_position.bump)]
    pub maker_position: Account<'info, MultiOutcomePosition>,
    #[account(mut,seeds=[ASSET_BALANCE_SEED,taker.key().as_ref(),market.collateral_mint.as_ref()],bump=taker_cash.bump)]
    pub taker_cash: Account<'info, AssetBalance>,
    #[account(mut,seeds=[MULTI_OUTCOME_POSITION_SEED,market.key().as_ref(),taker.key().as_ref()],bump=taker_position.bump)]
    pub taker_position: Account<'info, MultiOutcomePosition>,
}
/// Inputs: taker, canonical best maker and both owners' claims, exact limit,
/// quantity and expected fee bps. Errors: stale fees, priority, self/same-side,
/// closed/cutoff market, crossing, wrong bindings, funds or arithmetic.
/// Returns: at most one maker-price fill, partial maker retained at original ID,
/// zero maker fee and ceiling-rounded global taker fee. A buy taker pays extra
/// free cash; a sell taker pays from proceeds. No outcome supply/reserve changes.
pub fn handle_match_multi_outcome_order(
    ctx: Context<MatchMultiOutcomeOrder>,
    outcome: OutcomeId,
    taker_side: OrderSide,
    limit_price: u64,
    quantity: u64,
    expected_fee_bps: u16,
) -> Result<()> {
    let e = rules::book_terms(&ctx.accounts.market, &ctx.accounts.book, true)?;
    rules::notional(e, outcome, limit_price, quantity)?;
    require!(
        ctx.accounts.protocol_config.taker_fee_bps == expected_fee_bps,
        multi::MultiOutcomeFeeQuoteChanged
    );
    let maker = &ctx.accounts.maker_order;
    let index = rules::order_index(&ctx.accounts.book, e, maker.key(), maker)?;
    require!(
        maker.owner != ctx.accounts.taker.key(),
        matching::SelfTradeNotAllowed
    );
    require!(
        maker.outcome == outcome && maker.side != taker_side,
        matching::MatchingSameSide
    );
    let best = rules::best(&ctx.accounts.book, outcome, maker.side)
        .ok_or(multi::InvalidMultiOutcomeBook)?;
    require!(best.price == maker.price, matching::MakerNotAtBestPrice);
    require!(best.order == maker.key(), matching::MakerNotFifoHead);
    require!(
        if taker_side == OrderSide::Bid {
            limit_price >= maker.price
        } else {
            limit_price <= maker.price
        },
        matching::OrdersDoNotCross
    );
    asset(
        &ctx.accounts.maker_cash,
        maker.owner,
        ctx.accounts.market.collateral_mint,
    )?;
    asset(
        &ctx.accounts.taker_cash,
        ctx.accounts.taker.key(),
        ctx.accounts.market.collateral_mint,
    )?;
    rules::position(
        &ctx.accounts.market,
        &ctx.accounts.maker_position,
        maker.owner,
        ctx.accounts.market.key(),
    )?;
    rules::position(
        &ctx.accounts.market,
        &ctx.accounts.taker_position,
        ctx.accounts.taker.key(),
        ctx.accounts.market.key(),
    )?;
    let fill = quantity.min(maker.remaining_quantity);
    let cost = rules::notional(e, outcome, maker.price, fill)?;
    let fee = calculate_taker_fee(cost, expected_fee_bps)?;
    let accrued = ctx
        .accounts
        .book
        .accrued_collateral_fees
        .checked_add(fee)
        .ok_or(fee::FeeAccrualOverflow)?;
    let i = usize::from(outcome.index());
    if taker_side == OrderSide::Bid {
        let debit = cost.checked_add(fee).ok_or(balance::FreeBalanceOverflow)?;
        ctx.accounts.taker_cash.free = ctx
            .accounts
            .taker_cash
            .free
            .checked_sub(debit)
            .ok_or(balance::InsufficientFreeBalance)?;
        ctx.accounts.maker_cash.free = ctx
            .accounts
            .maker_cash
            .free
            .checked_add(cost)
            .ok_or(balance::FreeBalanceOverflow)?;
        ctx.accounts.maker_position.locked[i] = ctx.accounts.maker_position.locked[i]
            .checked_sub(fill)
            .ok_or(balance::LockedBalanceUnderflow)?;
        ctx.accounts.taker_position.free[i] = ctx.accounts.taker_position.free[i]
            .checked_add(fill)
            .ok_or(balance::FreeBalanceOverflow)?;
    } else {
        let proceeds = cost.checked_sub(fee).ok_or(fee::FeeCalculationOverflow)?;
        ctx.accounts.taker_position.free[i] = ctx.accounts.taker_position.free[i]
            .checked_sub(fill)
            .ok_or(balance::InsufficientFreeBalance)?;
        ctx.accounts.maker_position.free[i] = ctx.accounts.maker_position.free[i]
            .checked_add(fill)
            .ok_or(balance::FreeBalanceOverflow)?;
        ctx.accounts.maker_cash.locked = ctx
            .accounts
            .maker_cash
            .locked
            .checked_sub(cost)
            .ok_or(balance::LockedBalanceUnderflow)?;
        ctx.accounts.taker_cash.free = ctx
            .accounts
            .taker_cash
            .free
            .checked_add(proceeds)
            .ok_or(balance::FreeBalanceOverflow)?;
    }
    let o = &mut ctx.accounts.maker_order;
    o.remaining_quantity = o
        .remaining_quantity
        .checked_sub(fill)
        .ok_or(multi::InvalidMultiOutcomeBook)?;
    o.locked_amount = o
        .locked_amount
        .checked_sub(if o.side == OrderSide::Bid { cost } else { fill })
        .ok_or(multi::InvalidMultiOutcomeBook)?;
    if o.remaining_quantity == 0 {
        require!(o.locked_amount == 0, multi::InvalidMultiOutcomeBook);
        o.status = OrderStatus::Filled;
        ctx.accounts.book.orders.remove(index);
    }
    ctx.accounts.book.accrued_collateral_fees = accrued;
    ctx.accounts.market.open_order_count = ctx.accounts.book.orders.len() as u64;
    emit!(crate::MultiOutcomeFillEvent {
        market: ctx.accounts.market.key(),
        maker: ctx.accounts.maker_order.owner,
        taker: ctx.accounts.taker.key(),
        order: ctx.accounts.maker_order.key(),
        outcome,
        taker_side,
        price: ctx.accounts.maker_order.price,
        quantity: fill,
        collateral_atoms: cost,
        fee_atoms: fee
    });
    Ok(())
}
