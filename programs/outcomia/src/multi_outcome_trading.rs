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
        market.open_order_count == book.open_order_count && book.next_order_id > 0,
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
    book.heads[slot(outcome, side)]
}
/// Inputs: canonical open order and book. Errors: malformed remainder/backing
/// or absent/mismatched reference. Returns: index removed on fill/cancellation.
pub fn order_index(
    book: &MultiOutcomeBook,
    economics: MultiOutcomeEconomics,
    key: Pubkey,
    value: &MultiOutcomeOrder,
) -> Result<()> {
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
    require!(
        value.order_id > 0 && value.order_id < book.next_order_id,
        multi::InvalidMultiOutcomeBook
    );
    if value.previous.is_none() {
        require!(
            best(book, value.outcome, value.side).is_some_and(|r| r.order == key),
            multi::InvalidMultiOutcomeBook
        );
    }
    Ok(())
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

/// Stable root slot for an outcome/side pair. Callers validate the outcome first.
/// Best same-side heads of every outcome except `outcome`, in outcome order,
/// or `None` when any of them is missing (no full set can form).
pub fn complement_heads(
    book: &MultiOutcomeBook,
    e: MultiOutcomeEconomics,
    outcome: OutcomeId,
    side: OrderSide,
) -> Option<Vec<MultiOutcomeOrderReference>> {
    (0..e.outcome_count)
        .filter(|index| *index != outcome.index())
        .map(|index| OutcomeId::new(index, e.outcome_count).and_then(|o| best(book, o, side)))
        .collect()
}
/// Whether an order at `price` would complete a full set with the other
/// outcomes' best same-side orders: bids summing to at least the payout, or
/// asks summing to at most it. Such an order must be matched, not rested.
pub fn crosses_full_set(
    book: &MultiOutcomeBook,
    e: MultiOutcomeEconomics,
    outcome: OutcomeId,
    side: OrderSide,
    price: u64,
) -> bool {
    let Some(heads) = complement_heads(book, e, outcome, side) else {
        return false;
    };
    let combined: u128 =
        u128::from(price) + heads.iter().map(|r| u128::from(r.price)).sum::<u128>();
    match side {
        OrderSide::Bid => combined >= u128::from(e.payout_per_contract),
        OrderSide::Ask => combined <= u128::from(e.payout_per_contract),
    }
}
pub fn slot(outcome: OutcomeId, side: OrderSide) -> usize {
    usize::from(outcome.index()) * 2 + usize::from(side == OrderSide::Ask)
}
/// Reference cached in a root when its first order changes.
pub fn reference(key: Pubkey, o: &MultiOutcomeOrder) -> MultiOutcomeOrderReference {
    MultiOutcomeOrderReference {
        order: key,
        order_id: o.order_id,
        outcome: o.outcome,
        side: o.side,
        price: o.price,
    }
}
/// Validates a neighbor's canonical identity, escrow, and queue membership.
pub fn neighbor(
    book: &Account<MultiOutcomeBook>,
    e: MultiOutcomeEconomics,
    market: Pubkey,
    o: &Account<MultiOutcomeOrder>,
    outcome: OutcomeId,
    side: OrderSide,
) -> Result<()> {
    require!(
        o.market == market && o.book == book.key() && o.outcome == outcome && o.side == side,
        multi::InvalidMultiOutcomeBook
    );
    require!(
        crate::pda::address_with_bump(
            &[
                crate::constants::MULTI_OUTCOME_ORDER_SEED,
                book.key().as_ref(),
                &o.order_id.to_le_bytes()
            ],
            o.bump
        ) == Some(o.key()),
        multi::InvalidMultiOutcomeBook
    );
    order_index(book, e, o.key(), o)
}
/// True when a precedes b in maker price-time priority.
pub fn precedes(a: &MultiOutcomeOrder, b: &MultiOutcomeOrder) -> bool {
    if a.price == b.price {
        a.order_id < b.order_id
    } else if a.side == OrderSide::Bid {
        a.price > b.price
    } else {
        a.price < b.price
    }
}
/// Removes one order with exact reciprocal neighbors. No scan or fixed capacity.
pub fn unlink(
    book: &mut Account<MultiOutcomeBook>,
    e: MultiOutcomeEconomics,
    key: Pubkey,
    o: &MultiOutcomeOrder,
    previous: Option<&mut Account<MultiOutcomeOrder>>,
    next: Option<&mut Account<MultiOutcomeOrder>>,
) -> Result<()> {
    require!(
        o.previous == previous.as_ref().map(|p| p.key())
            && o.next == next.as_ref().map(|n| n.key()),
        multi::InvalidMultiOutcomeBook
    );
    if let Some(p) = previous.as_ref() {
        neighbor(book, e, o.market, p, o.outcome, o.side)?;
        require!(
            p.next == Some(key) && precedes(p, o),
            multi::InvalidMultiOutcomeBook
        );
    } else {
        require!(
            best(book, o.outcome, o.side).is_some_and(|r| r.order == key),
            multi::InvalidMultiOutcomeBook
        );
    }
    if let Some(n) = next.as_ref() {
        neighbor(book, e, o.market, n, o.outcome, o.side)?;
        require!(
            n.previous == Some(key) && precedes(o, n),
            multi::InvalidMultiOutcomeBook
        );
    }
    if let Some(p) = previous {
        p.next = o.next;
    } else {
        book.heads[slot(o.outcome, o.side)] = next.as_ref().map(|n| reference(n.key(), n));
    }
    if let Some(n) = next {
        n.previous = o.previous;
    }
    book.open_order_count = book
        .open_order_count
        .checked_sub(1)
        .ok_or(multi::InvalidMultiOutcomeBook)?;
    Ok(())
}
