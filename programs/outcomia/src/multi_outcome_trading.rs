//! Bounded multi-outcome priority and exact order accounting. The book's signed
//! references select best price/FIFO without trusting a client-selected maker.
use crate::{
    errors::{multi_outcome as multi, order, prediction},
    multi_outcome::{reserve_liability, validate_quantities, MultiOutcomeEconomics},
    state::*,
};
use anchor_lang::prelude::*;

/// Inputs: canonical market/book and whether new exposure is requested.
/// Errors: count/index inconsistency, invalid terms or closed/expired trading.
/// Returns: economic view derived only from stored immutable market terms.
pub fn book_terms(
    market: &MultiOutcomeMarket,
    book: &MultiOutcomeBook,
    trading: bool,
) -> Result<MultiOutcomeEconomics> {
    let e = MultiOutcomeEconomics::from_terms(&market.terms)?;
    require!(
        book.orders.len() <= MULTI_OUTCOME_MAX_ORDERS
            && market.open_order_count == book.orders.len() as u64
            && book.next_order_id > 0,
        multi::InvalidMultiOutcomeBook
    );
    if trading {
        require!(
            market.status == PredictionStatus::Open
                && market.final_outcome.is_none()
                && Clock::get()?.unix_timestamp < market.terms.close_ts,
            prediction::PredictionOrderUnavailable
        );
    }
    for (index, r) in book.orders.iter().enumerate() {
        require!(
            r.outcome.is_valid_for(e.outcome_count)
                && r.order_id > 0
                && r.order_id < book.next_order_id
                && r.price > 0
                && r.price < e.payout_per_contract
                && r.price.is_multiple_of(e.price_tick),
            multi::InvalidMultiOutcomeBook
        );
        require!(
            !book.orders[..index]
                .iter()
                .any(|old| old.order_id == r.order_id || old.order == r.order),
            multi::InvalidMultiOutcomeBook
        );
    }
    require!(
        reserve_liability(e, &market.supplies, market.final_outcome)? == market.backing_reserve,
        multi::MultiOutcomeReserveMismatch
    );
    Ok(e)
}
/// Inputs: immutable economics and an outcome/price/quantity. Errors: invalid
/// outcome, tick/lot, overflow or zero notional. Returns: price*quantity atoms.
pub fn notional(
    e: MultiOutcomeEconomics,
    outcome: OutcomeId,
    price: u64,
    quantity: u64,
) -> Result<u64> {
    require!(
        outcome.is_valid_for(e.outcome_count),
        multi::InvalidMultiOutcomeId
    );
    require!(
        price > 0 && price < e.payout_per_contract && price.is_multiple_of(e.price_tick),
        multi::InvalidMultiOutcomePrice
    );
    require!(
        quantity > 0 && quantity.is_multiple_of(e.quantity_lot),
        multi::InvalidMultiOutcomeLot
    );
    u64::try_from(u128::from(price) * u128::from(quantity))
        .map_err(|_| error!(order::OrderNotionalOverflow))
}
/// Inputs: bounded book, outcome and resting side. Errors: none. Returns the
/// highest bid/lowest ask, then earliest acceptance ID at that price.
pub fn best(
    book: &MultiOutcomeBook,
    outcome: OutcomeId,
    side: OrderSide,
) -> Option<MultiOutcomeOrderReference> {
    book.orders
        .iter()
        .filter(|r| r.outcome == outcome && r.side == side)
        .copied()
        .reduce(|a, b| {
            if (b.price == a.price && b.order_id < a.order_id)
                || (b.price != a.price
                    && match side {
                        OrderSide::Bid => b.price > a.price,
                        OrderSide::Ask => b.price < a.price,
                    })
            {
                b
            } else {
                a
            }
        })
}
/// Inputs: canonical open order and book. Errors: malformed remainder/backing
/// or absent/mismatched reference. Returns: index removed on fill/cancellation.
pub fn order_index(
    book: &MultiOutcomeBook,
    economics: MultiOutcomeEconomics,
    key: Pubkey,
    value: &MultiOutcomeOrder,
) -> Result<usize> {
    require!(
        value.status == OrderStatus::Open
            && value.remaining_quantity > 0
            && value.remaining_quantity <= value.quantity,
        multi::InvalidMultiOutcomeBook
    );
    notional(economics, value.outcome, value.price, value.quantity)?;
    notional(
        economics,
        value.outcome,
        value.price,
        value.remaining_quantity,
    )?;
    let expected = if value.side == OrderSide::Bid {
        value
            .price
            .checked_mul(value.remaining_quantity)
            .ok_or(order::OrderNotionalOverflow)?
    } else {
        value.remaining_quantity
    };
    require!(
        value.locked_amount == expected,
        multi::InvalidMultiOutcomeBook
    );
    book.orders
        .iter()
        .position(|r| {
            r.order == key
                && r.order_id == value.order_id
                && r.outcome == value.outcome
                && r.side == value.side
                && r.price == value.price
        })
        .ok_or_else(|| error!(multi::InvalidMultiOutcomeBook))
}
/// Inputs: market, position, owner and exact market key. Errors: wrong binding,
/// off-lot/inactive slots or owned amounts beyond outstanding supply. Returns:
/// validated outcome buckets. Account PDA checks remain in instruction contexts.
pub fn position(
    market: &MultiOutcomeMarket,
    p: &MultiOutcomePosition,
    owner: Pubkey,
    key: Pubkey,
) -> Result<()> {
    require!(
        p.owner == owner && p.market == key,
        multi::InvalidMultiOutcomePosition
    );
    let e = MultiOutcomeEconomics::from_terms(&market.terms)?;
    validate_quantities(e, &p.free)?;
    validate_quantities(e, &p.locked)?;
    for i in 0..usize::from(e.outcome_count) {
        require!(
            p.free[i]
                .checked_add(p.locked[i])
                .ok_or(multi::MultiOutcomeAccountingOverflow)?
                <= market.supplies[i],
            multi::InvalidMultiOutcomePosition
        );
    }
    Ok(())
}
