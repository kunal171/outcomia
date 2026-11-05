//! Settles one best-price FIFO maker against a signing taker's free balance.
//!
//! YES and NO books remain separate. Quantity is capped at this maker's
//! remainder, execution uses its resting price, and excess taker quantity is
//! neither posted nor reserved. No SPL transfer or payout-reserve change occurs.
//! Taker fees use the existing global rate and collateral-denominated market
//! accumulator. Maker backing excludes fees: the arriving taker pays them.
//!
//! Example with six-decimal collateral and 25 bps: 3 contracts at maker price
//! 600,000 exchange 1,800,000 cash atoms, and the fee is 4,500. A buying taker
//! spends 1,804,500; a selling taker receives 1,795,500. The protocol owns the
//! 4,500 fee atoms in the same vault. YES/NO supply and payout reserve do not
//! change: this trades existing claims rather than splitting new pairs.

use crate::{
    constants::*,
    errors::{balance, fee, prediction},
    fees::calculate_taker_fee,
    pda::{derive_prediction_order_pda, derive_prediction_price_level_pda},
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(outcome: PredictionOutcome)]
pub struct MatchPredictionOrder<'info> {
    pub taker: Signer<'info>,
    #[account(mut, seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut, seeds = [PREDICTION_BOOK_SEED, market.key().as_ref()], bump = order_book.bump,
        has_one = market @ prediction::PredictionBookMarketMismatch)]
    pub order_book: Box<Account<'info, PredictionOrderBook>>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [MARKET_FEES_SEED, market.key().as_ref()], bump = market_fees.bump,
        has_one = market @ fee::MarketFeesMarketMismatch,
        constraint = market_fees.quote_mint == market.collateral_mint @ fee::MarketFeesQuoteMintMismatch)]
    pub market_fees: Box<Account<'info, MarketFees>>,
    #[account(mut, seeds = [PREDICTION_ORDER_SEED, market.key().as_ref(), &maker_order.order_id.to_le_bytes()], bump = maker_order.bump,
        has_one = market @ prediction::PredictionPositionMarketMismatch,
        constraint = maker_order.outcome == outcome @ prediction::InvalidPredictionPriceLevel,
        constraint = maker_order.owner != taker.key() @ prediction::PredictionSelfTrade)]
    pub maker_order: Box<Account<'info, PredictionOrder>>,
    #[account(mut, seeds = [PREDICTION_PRICE_LEVEL_SEED, market.key().as_ref(), outcome.seed(), maker_order.side.seed(), &maker_order.price.to_le_bytes()], bump = price_level.bump,
        has_one = market @ prediction::InvalidPredictionPriceLevel,
        constraint = price_level.outcome == outcome && price_level.side == maker_order.side && price_level.price == maker_order.price
            && maker_order.price_level == price_level.key() @ prediction::InvalidPredictionPriceLevel)]
    pub price_level: Box<Account<'info, PredictionPriceLevel>>,
    #[account(mut, seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), maker_order.owner.as_ref()], bump = maker_position.bump,
        has_one = market @ prediction::PredictionPositionMarketMismatch,
        constraint = maker_position.owner == maker_order.owner @ prediction::PredictionPositionOwnerMismatch)]
    pub maker_position: Box<Account<'info, PredictionPosition>>,
    #[account(mut, seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), taker.key().as_ref()], bump = taker_position.bump,
        has_one = market @ prediction::PredictionPositionMarketMismatch,
        constraint = taker_position.owner == taker.key() @ prediction::PredictionPositionOwnerMismatch)]
    pub taker_position: Box<Account<'info, PredictionPosition>>,
    /// Only supplied when a full fill promotes the next FIFO order.
    #[account(mut)]
    pub next_order: Option<Box<Account<'info, PredictionOrder>>>,
    /// Only supplied when a full fill empties the current best price level.
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, PredictionPriceLevel>>>,
    /// CHECK: On level closure this must equal price_level.rent_payer.
    #[account(mut)]
    pub level_rent_recipient: Option<UncheckedAccount<'info>>,
}

/// Settles one prediction maker and collateral-denominated taker fee.
///
/// # Inputs
/// `ctx`: taker, market/book/config/fees, best FIFO maker, two positions and removal hints;
/// outcome, side, limit and whole quantity.
///
/// # Errors
/// Closed trading, invalid grid/backing/accounts, skipped priority, self/same-side/noncrossing
/// trade, insufficient claims, overflow or stale hints.
///
/// # Returns
/// `Ok(())` after up to one maker fills at its resting price; excess stays unposted and next order
/// ID is unchanged.
pub fn handle_match_prediction_order(
    ctx: Context<MatchPredictionOrder>,
    outcome: PredictionOutcome,
    taker_side: OrderSide,
    limit_price: u64,
    quantity: u64,
) -> Result<()> {
    let market = &ctx.accounts.market;
    let maker = &ctx.accounts.maker_order;
    let level = &ctx.accounts.price_level;
    require!(
        market.status == PredictionStatus::Open && Clock::get()?.unix_timestamp < market.close_ts,
        prediction::PredictionOrderUnavailable
    );
    require!(quantity > 0, prediction::InvalidPredictionContractQuantity);
    require!(
        limit_price > 0
            && limit_price < market.payout_per_contract
            && market.price_tick > 0
            && limit_price.is_multiple_of(market.price_tick),
        prediction::InvalidPredictionOrderPrice
    );
    require!(
        maker.status == OrderStatus::Open,
        prediction::PredictionOrderNotOpen
    );
    require!(
        maker.owner != ctx.accounts.taker.key(),
        prediction::PredictionSelfTrade
    );
    require!(
        maker.side != taker_side,
        prediction::PredictionMatchingSameSide
    );
    require!(
        match taker_side {
            OrderSide::Bid => limit_price >= maker.price,
            OrderSide::Ask => limit_price <= maker.price,
        },
        prediction::PredictionOrdersDoNotCross
    );
    require!(
        ctx.accounts.order_book.best_price(outcome, maker.side) == Some(maker.price)
            && level.better_price.is_none(),
        prediction::PredictionMakerNotBest
    );
    require!(
        level.first_order == Some(maker.key()) && maker.previous_order.is_none(),
        prediction::PredictionMakerNotHead
    );
    require!(
        maker.order_id > 0
            && maker.order_id < ctx.accounts.order_book.next_order_id
            && maker.remaining_quantity > 0
            && maker.remaining_quantity <= maker.quantity
            && maker.price > 0
            && maker.price < market.payout_per_contract
            && maker.price.is_multiple_of(market.price_tick)
            && level.order_count > 0
            && level.total_remaining_quantity >= maker.remaining_quantity
            && level.last_order.is_some(),
        prediction::PredictionOrderAccountingMismatch
    );
    let expected_backing = match maker.side {
        OrderSide::Bid => maker
            .price
            .checked_mul(maker.remaining_quantity)
            .ok_or(prediction::PredictionAccountingOverflow)?,
        OrderSide::Ask => maker.remaining_quantity,
    };
    require!(
        maker.locked_collateral == expected_backing,
        prediction::PredictionOrderAccountingMismatch
    );
    // Validate both one-element and longer FIFO endpoints even for partial fills.
    require!(
        if level.order_count == 1 {
            level.last_order == Some(maker.key())
                && maker.next_order.is_none()
                && level.total_remaining_quantity == maker.remaining_quantity
        } else {
            level.last_order != Some(maker.key())
                && maker.next_order.is_some()
                && maker.next_order != Some(maker.key())
                && level.total_remaining_quantity > maker.remaining_quantity
        },
        prediction::PredictionOrderAccountingMismatch
    );
    // An oversized request is bounded by this one maker. Requesting 10 when
    // the maker has 3 executes 3; the other 7 create no order or locked claim.
    let fill = quantity.min(maker.remaining_quantity);
    // Whole contracts make notional exact; no decimal rescaling or rounding.
    let notional = maker
        .price
        .checked_mul(fill)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let taker_fee = calculate_taker_fee(notional, ctx.accounts.protocol_config.taker_fee_bps)?;
    let accrued = ctx
        .accounts
        .market_fees
        .accrued_quote_fees
        .checked_add(taker_fee)
        .ok_or(fee::FeeAccrualOverflow)?;
    let remaining = maker.remaining_quantity - fill;
    let full = remaining == 0;
    let removes_level = full && level.order_count == 1;
    let level_quantity = level
        .total_remaining_quantity
        .checked_sub(fill)
        .ok_or(prediction::PredictionOrderAccountingMismatch)?;
    if full && !removes_level {
        let next = ctx
            .accounts
            .next_order
            .as_ref()
            .ok_or(prediction::InvalidPredictionOrderNeighbor)?;
        let (expected, bump) =
            derive_prediction_order_pda(ctx.program_id, &market.key(), next.order_id);
        require!(
            Some(next.key()) == maker.next_order
                && next.key() == expected
                && next.bump == bump
                && next.market == market.key()
                && next.outcome == outcome
                && next.side == maker.side
                && next.price == maker.price
                && next.price_level == level.key()
                && next.status == OrderStatus::Open
                && next.previous_order == Some(maker.key())
                && next.order_id > maker.order_id
                && next.remaining_quantity > 0
                && next.remaining_quantity <= next.quantity,
            prediction::InvalidPredictionOrderNeighbor
        );
    } else {
        require!(
            ctx.accounts.next_order.is_none(),
            prediction::InvalidPredictionOrderNeighbor
        );
    }
    if removes_level {
        require!(
            level_quantity == 0,
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
        let expected = level.worse_price.map(|price| {
            derive_prediction_price_level_pda(
                ctx.program_id,
                &market.key(),
                outcome,
                maker.side,
                price,
            )
            .0
        });
        require!(
            ctx.accounts.worse_level.as_ref().map(|l| l.key()) == expected,
            prediction::InvalidPredictionPriceLevel
        );
        if let Some(worse) = ctx.accounts.worse_level.as_ref() {
            let (_, bump) = derive_prediction_price_level_pda(
                ctx.program_id,
                &market.key(),
                outcome,
                maker.side,
                worse.price,
            );
            require!(
                worse.bump == bump
                    && worse.market == market.key()
                    && worse.outcome == outcome
                    && worse.side == maker.side
                    && worse.better_price == Some(level.price)
                    && worse.order_count > 0
                    && worse.total_remaining_quantity > 0
                    && worse.first_order.is_some()
                    && worse.last_order.is_some()
                    && match maker.side {
                        OrderSide::Bid => worse.price < maker.price,
                        OrderSide::Ask => worse.price > maker.price,
                    },
                prediction::InvalidPredictionPriceLevel
            );
        }
    } else {
        require!(
            ctx.accounts.worse_level.is_none() && ctx.accounts.level_rent_recipient.is_none(),
            prediction::InvalidPredictionPriceLevel
        );
    }
    let new_count = if full {
        market
            .open_order_count
            .checked_sub(1)
            .ok_or(prediction::PredictionOrderAccountingMismatch)?
    } else {
        market.open_order_count
    };
    // Settle four claim buckets and fees, never the vault or backing reserve.
    // Maker signatures are unnecessary: its signed resting order authorized
    // this price and quantity. Self-trades were rejected before touching ledgers.
    let maker_position: &mut PredictionPosition = &mut ctx.accounts.maker_position;
    let taker_position: &mut PredictionPosition = &mut ctx.accounts.taker_position;
    match taker_side {
        OrderSide::Bid => {
            let maker_locked = match outcome {
                PredictionOutcome::Yes => &mut maker_position.yes_locked,
                PredictionOutcome::No => &mut maker_position.no_locked,
            };
            require!(
                *maker_locked >= expected_backing,
                prediction::PredictionOrderAccountingMismatch
            );
            let cost = notional
                .checked_add(taker_fee)
                .ok_or(prediction::PredictionAccountingOverflow)?;
            taker_position.collateral_free = taker_position
                .collateral_free
                .checked_sub(cost)
                .ok_or(balance::InsufficientFreeBalance)?;
            maker_position.collateral_free = maker_position
                .collateral_free
                .checked_add(notional)
                .ok_or(balance::FreeBalanceOverflow)?;
            *maker_locked = maker_locked
                .checked_sub(fill)
                .ok_or(balance::LockedBalanceUnderflow)?;
            let taker_free = match outcome {
                PredictionOutcome::Yes => &mut taker_position.yes_free,
                PredictionOutcome::No => &mut taker_position.no_free,
            };
            *taker_free = taker_free
                .checked_add(fill)
                .ok_or(prediction::PredictionAccountingOverflow)?;
        }
        OrderSide::Ask => {
            require!(
                maker_position.collateral_locked >= expected_backing,
                prediction::PredictionOrderAccountingMismatch
            );
            let taker_free = match outcome {
                PredictionOutcome::Yes => &mut taker_position.yes_free,
                PredictionOutcome::No => &mut taker_position.no_free,
            };
            *taker_free = taker_free
                .checked_sub(fill)
                .ok_or(prediction::InsufficientPredictionPositions)?;
            let proceeds = notional
                .checked_sub(taker_fee)
                .ok_or(prediction::PredictionOrderAccountingMismatch)?;
            taker_position.collateral_free = taker_position
                .collateral_free
                .checked_add(proceeds)
                .ok_or(balance::FreeBalanceOverflow)?;
            maker_position.collateral_locked = maker_position
                .collateral_locked
                .checked_sub(notional)
                .ok_or(balance::LockedBalanceUnderflow)?;
            let maker_free = match outcome {
                PredictionOutcome::Yes => &mut maker_position.yes_free,
                PredictionOutcome::No => &mut maker_position.no_free,
            };
            *maker_free = maker_free
                .checked_add(fill)
                .ok_or(prediction::PredictionAccountingOverflow)?;
        }
    }
    ctx.accounts.market_fees.accrued_quote_fees = accrued;
    ctx.accounts.market.open_order_count = new_count;
    let debit = if maker.side == OrderSide::Bid {
        notional
    } else {
        fill
    };
    let new_backing = maker
        .locked_collateral
        .checked_sub(debit)
        .ok_or(prediction::PredictionOrderAccountingMismatch)?;
    let maker_next = maker.next_order;
    let maker = &mut ctx.accounts.maker_order;
    maker.remaining_quantity = remaining;
    maker.locked_collateral = new_backing;
    ctx.accounts.price_level.total_remaining_quantity = level_quantity;
    if full {
        maker.status = OrderStatus::Filled;
        maker.previous_order = None;
        maker.next_order = None;
        ctx.accounts.price_level.order_count -= 1;
        ctx.accounts.price_level.first_order = maker_next;
        if let Some(next) = ctx.accounts.next_order.as_mut() {
            next.previous_order = None;
        }
    }
    if removes_level {
        ctx.accounts.order_book.set_best_price(
            outcome,
            maker.side,
            ctx.accounts.price_level.worse_price,
        );
        if let Some(worse) = ctx.accounts.worse_level.as_mut() {
            worse.better_price = None;
        }
        let recipient = ctx
            .accounts
            .level_rent_recipient
            .as_ref()
            .ok_or(prediction::InvalidPredictionRentRecipient)?;
        ctx.accounts
            .price_level
            .close(recipient.to_account_info())?;
    }
    // next_order_id stays unchanged: this instruction creates no taker order.
    Ok(())
}
