//! One best-price FIFO fill using global cash and market-specific outcome claims.
//! No vault CPI is needed: maker/taker claims and the book's fee claim conserve custody.
use crate::{
    constants::*,
    errors::{balance, fee, matching, shared},
    fees::calculate_taker_fee,
    matching::calculate_settlement,
    shared_trading as rules,
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct MatchSharedOrder<'info> {
    pub taker: Signer<'info>,
    /// CHECK: Handler decodes and verifies the bound market and live trading window.
    #[account(owner = crate::ID)]
    pub market: UncheckedAccount<'info>,
    #[account(mut, seeds = [SHARED_BOOK_SEED, market.key().as_ref()], bump = book.bump,
        has_one = market @ shared::InvalidSharedBook)]
    pub book: Box<Account<'info, SharedBook>>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub maker_order: Box<Account<'info, SharedOrder>>,
    #[account(mut)]
    pub price_level: Box<Account<'info, SharedPriceLevel>>,
    #[account(mut)]
    pub maker_base: Option<Box<Account<'info, AssetBalance>>>,
    #[account(mut)]
    pub maker_quote: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub maker_position: Option<Box<Account<'info, PredictionPosition>>>,
    #[account(mut)]
    pub taker_base: Option<Box<Account<'info, AssetBalance>>>,
    #[account(mut)]
    pub taker_quote: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub taker_position: Option<Box<Account<'info, PredictionPosition>>>,
    #[account(mut)]
    pub next_order: Option<Box<Account<'info, SharedOrder>>>,
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    /// CHECK: Bound to the original level payer when its final maker is removed.
    #[account(mut)]
    pub level_rent_recipient: Option<UncheckedAccount<'info>>,
}

/// Fills at the oldest maker's price and settles both users plus the taker fee atomically.
///
/// # Inputs
/// Taker/source/root/config, best FIFO maker/level, both traders' canonical claims and exact
/// removal hints; outcome, taker side, limit price and base atoms/whole contracts.
/// # Errors
/// Closed trading, self/same-side/noncrossing trade, skipped priority, bad accounts, funds,
/// arithmetic, stale queue hints or rent redirection.
/// # Returns
/// `Ok(())` after up to one maker fills. A client may compose more fills and a safe remainder.
pub fn handle_match_shared_order(
    ctx: Context<MatchSharedOrder>,
    outcome: SharedOutcome,
    taker_side: OrderSide,
    limit_price: u64,
    quantity: u64,
) -> Result<()> {
    rules::trading_open(&ctx.accounts.book, &ctx.accounts.market.to_account_info())?;
    let accounts = &mut *ctx.accounts;
    match_order(
        &mut MatchAccounts {
            taker: accounts.taker.key(),
            taker_fee_bps: accounts.protocol_config.taker_fee_bps,
            book: &mut accounts.book,
            maker_order: &mut accounts.maker_order,
            price_level: &mut accounts.price_level,
            maker_base: &mut accounts.maker_base,
            maker_quote: &mut accounts.maker_quote,
            maker_position: &mut accounts.maker_position,
            taker_base: &mut accounts.taker_base,
            taker_quote: &mut accounts.taker_quote,
            taker_position: &mut accounts.taker_position,
            next_order: &mut accounts.next_order,
            worse_level: &mut accounts.worse_level,
            level_rent_recipient: &accounts.level_rent_recipient,
        },
        outcome,
        taker_side,
        limit_price,
        quantity,
    )
    .map(|_| ())
}

/// Validated accounts of one direct fill, independent of the book's namespace.
/// The caller has already checked that the book's market is trading.
pub(crate) struct MatchAccounts<'a, 'info> {
    pub taker: Pubkey,
    pub taker_fee_bps: u16,
    pub book: &'a mut Box<Account<'info, SharedBook>>,
    pub maker_order: &'a mut Box<Account<'info, SharedOrder>>,
    pub price_level: &'a mut Box<Account<'info, SharedPriceLevel>>,
    pub maker_base: &'a mut Option<Box<Account<'info, AssetBalance>>>,
    pub maker_quote: &'a mut Box<Account<'info, AssetBalance>>,
    pub maker_position: &'a mut Option<Box<Account<'info, PredictionPosition>>>,
    pub taker_base: &'a mut Option<Box<Account<'info, AssetBalance>>>,
    pub taker_quote: &'a mut Box<Account<'info, AssetBalance>>,
    pub taker_position: &'a mut Option<Box<Account<'info, PredictionPosition>>>,
    pub next_order: &'a mut Option<Box<Account<'info, SharedOrder>>>,
    pub worse_level: &'a mut Option<Box<Account<'info, SharedPriceLevel>>>,
    pub level_rent_recipient: &'a Option<UncheckedAccount<'info>>,
}

/// Direct fill shared by public and club books; see [`handle_match_shared_order`].
///
/// # Returns
/// The taker fee charged, which has been accrued to the book in full.
pub(crate) fn match_order(
    a: &mut MatchAccounts,
    outcome: SharedOutcome,
    taker_side: OrderSide,
    limit_price: u64,
    quantity: u64,
) -> Result<u64> {
    let book = &mut *a.book;
    let (slot, _) = rules::order_terms(book, outcome, taker_side, limit_price, quantity)?;
    let maker = &a.maker_order;
    rules::order(maker, book)?;
    rules::level(a.price_level, book)?;
    require!(maker.owner != a.taker, matching::SelfTradeNotAllowed);
    require!(
        maker.outcome == outcome
            && maker.price_level == a.price_level.key()
            && a.price_level.outcome == outcome
            && a.price_level.side == maker.side
            && a.price_level.price == maker.price,
        shared::InvalidSharedNeighbor
    );
    require!(
        book.best_prices[slot ^ 1] == Some(maker.price) && a.price_level.better_price.is_none(),
        matching::MakerNotAtBestPrice
    );
    require!(
        a.price_level.first_order == Some(maker.key()) && maker.previous_order.is_none(),
        matching::MakerNotFifoHead
    );
    rules::trader(
        book,
        maker.owner,
        a.maker_base.as_deref(),
        a.maker_quote,
        a.maker_position.as_deref(),
    )?;
    rules::trader(
        book,
        a.taker,
        a.taker_base.as_deref(),
        a.taker_quote,
        a.taker_position.as_deref(),
    )?;
    let plan = calculate_settlement(
        taker_side,
        limit_price,
        quantity,
        maker.side,
        maker.price,
        maker.remaining_quantity,
        maker.locked_collateral,
        book.base_decimals,
    )?;
    let fee = calculate_taker_fee(plan.fill.quote_quantity, a.taker_fee_bps)?;
    let accrued = book
        .accrued_quote_fees
        .checked_add(fee)
        .ok_or(fee::FeeAccrualOverflow)?;
    let remaining = maker
        .remaining_quantity
        .checked_sub(plan.fill.base_quantity)
        .ok_or(shared::InvalidSharedBook)?;
    let collateral = maker
        .locked_collateral
        .checked_sub(plan.maker_locked_debit)
        .ok_or(shared::InvalidSharedBook)?;
    let total = a
        .price_level
        .total_remaining_quantity
        .checked_sub(plan.fill.base_quantity)
        .ok_or(shared::InvalidSharedBook)?;
    if !plan.maker_fully_filled {
        require!(
            a.next_order.is_none() && a.worse_level.is_none() && a.level_rent_recipient.is_none(),
            shared::InvalidSharedNeighbor
        );
    }
    // The maker's *order* determines the debit. Its global locked bucket may
    // also back orders in other markets; those locks are never released here.
    let (maker_free, maker_locked) = rules::base_buckets(
        book.kind,
        outcome,
        a.maker_base.as_deref_mut(),
        a.maker_position.as_deref_mut(),
    )?;
    let (taker_free, _) = rules::base_buckets(
        book.kind,
        outcome,
        a.taker_base.as_deref_mut(),
        a.taker_position.as_deref_mut(),
    )?;
    match taker_side {
        OrderSide::Bid => {
            let cost = plan
                .fill
                .quote_quantity
                .checked_add(fee)
                .ok_or(balance::FreeBalanceOverflow)?;
            a.taker_quote.free = a
                .taker_quote
                .free
                .checked_sub(cost)
                .ok_or(balance::InsufficientFreeBalance)?;
            a.maker_quote.free = a
                .maker_quote
                .free
                .checked_add(plan.fill.quote_quantity)
                .ok_or(balance::FreeBalanceOverflow)?;
            *maker_locked = maker_locked
                .checked_sub(plan.maker_locked_debit)
                .ok_or(balance::LockedBalanceUnderflow)?;
            *taker_free = taker_free
                .checked_add(plan.fill.base_quantity)
                .ok_or(balance::FreeBalanceOverflow)?;
        }
        OrderSide::Ask => {
            let proceeds = plan
                .fill
                .quote_quantity
                .checked_sub(fee)
                .ok_or(fee::FeeCalculationOverflow)?;
            *taker_free = taker_free
                .checked_sub(plan.fill.base_quantity)
                .ok_or(balance::InsufficientFreeBalance)?;
            *maker_free = maker_free
                .checked_add(plan.fill.base_quantity)
                .ok_or(balance::FreeBalanceOverflow)?;
            a.taker_quote.free = a
                .taker_quote
                .free
                .checked_add(proceeds)
                .ok_or(balance::FreeBalanceOverflow)?;
            a.maker_quote.locked = a
                .maker_quote
                .locked
                .checked_sub(plan.maker_locked_debit)
                .ok_or(balance::LockedBalanceUnderflow)?;
            a.maker_quote.free = a
                .maker_quote
                .free
                .checked_add(plan.maker_quote_refund)
                .ok_or(balance::FreeBalanceOverflow)?;
        }
    }
    // Every error, including an invalid late removal hint or close CPI, rolls
    // back both preceding claim mutations and all earlier fills in this transaction.
    if plan.maker_fully_filled {
        rules::remove_order(
            book,
            a.maker_order,
            a.price_level,
            None,
            a.next_order.as_deref_mut(),
            None,
            a.worse_level.as_deref_mut(),
            a.level_rent_recipient.as_ref(),
        )?;
    } else {
        a.price_level.total_remaining_quantity = total;
    }
    a.maker_order.remaining_quantity = remaining;
    a.maker_order.locked_collateral = collateral;
    if plan.maker_fully_filled {
        a.maker_order.status = OrderStatus::Filled;
        a.maker_order.previous_order = None;
        a.maker_order.next_order = None;
    }
    book.accrued_quote_fees = accrued;
    msg!(
        "Shared fill: market={} price={} quantity={} fee={}",
        book.market,
        plan.fill.execution_price,
        plan.fill.base_quantity,
        fee
    );
    Ok(fee)
}
