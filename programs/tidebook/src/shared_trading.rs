//! Validation and queue primitives shared by spot and YES/NO global-wallet execution.
//! Cash locks are global by mint; prediction contract locks remain per question.
use crate::{
    constants::*,
    errors::{balance, market, order, prediction, shared},
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Clone, Copy)]
pub struct SharedTerms {
    pub authority: Pubkey,
    pub kind: MarketKind,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_decimals: u8,
    pub quote_decimals: u8,
    pub tick: u64,
    pub lot: u64,
    pub payout: u64,
}

/// Inputs: program-owned market info, selected kind, and whether trading must be open.
/// Errors: wrong type/PDA, inactive/expired trading or malformed precision.
/// Returns: immutable economic parameters; labels are deliberately irrelevant.
pub fn terms(info: &AccountInfo<'_>, kind: MarketKind, trading: bool) -> Result<SharedTerms> {
    require_keys_eq!(*info.owner, crate::ID, shared::SharedMarketKindMismatch);
    let data = info.try_borrow_data()?;
    match kind {
        MarketKind::Spot => {
            let value = Market::try_deserialize(&mut data.as_ref())?;
            require_keys_eq!(
                Pubkey::find_program_address(
                    &[
                        MARKET_SEED,
                        value.base_mint.as_ref(),
                        value.quote_mint.as_ref()
                    ],
                    &crate::ID
                )
                .0,
                *info.key,
                shared::SharedMarketKindMismatch
            );
            if trading {
                require!(
                    value.status == MarketStatus::Active,
                    market::MarketNotActive
                );
            }
            Ok(SharedTerms {
                authority: value.authority,
                kind,
                base_mint: value.base_mint,
                quote_mint: value.quote_mint,
                base_decimals: value.base_decimals,
                quote_decimals: value.quote_decimals,
                tick: value.price_tick_size,
                lot: value.quantity_lot_size,
                payout: 0,
            })
        }
        MarketKind::Prediction => {
            let value = PredictionMarket::try_deserialize(&mut data.as_ref())?;
            require_keys_eq!(
                Pubkey::find_program_address(
                    &[PREDICTION_MARKET_SEED, value.market_id.as_ref()],
                    &crate::ID
                )
                .0,
                *info.key,
                shared::SharedMarketKindMismatch
            );
            if trading {
                require!(
                    value.status == PredictionStatus::Open
                        && Clock::get()?.unix_timestamp < value.close_ts,
                    prediction::PredictionOrderUnavailable
                );
            }
            let precision = value
                .payout_per_contract
                .checked_ilog10()
                .ok_or(prediction::InvalidPredictionPayout)?;
            require!(
                10_u64.checked_pow(precision) == Some(value.payout_per_contract),
                prediction::InvalidPredictionPayout
            );
            Ok(SharedTerms {
                authority: value.authority,
                kind,
                base_mint: Pubkey::default(),
                quote_mint: value.collateral_mint,
                base_decimals: 0,
                quote_decimals: precision as u8,
                tick: value.price_tick,
                lot: 1,
                payout: value.payout_per_contract,
            })
        }
        MarketKind::Other => err!(shared::SharedMarketKindMismatch),
    }
}

/// Inputs: root and underlying market. Errors: immutable bindings changed or trading closed.
/// Returns: success only when this book uses the current market's economic terms.
pub fn trading_open(book: &SharedBook, market: &AccountInfo<'_>) -> Result<()> {
    require_keys_eq!(book.market, *market.key, shared::InvalidSharedBook);
    let value = terms(market, book.kind, true)?;
    require!(
        book.authority == value.authority
            && book.base_mint == value.base_mint
            && book.quote_mint == value.quote_mint
            && book.base_decimals == value.base_decimals
            && book.quote_decimals == value.quote_decimals
            && book.price_tick == value.tick
            && book.quantity_lot == value.lot
            && book.payout_per_contract == value.payout,
        shared::InvalidSharedBook
    );
    Ok(())
}

/// Inputs: book, outcome, side, raw price and quantity. Errors: wrong list/grid/range or zero units.
/// Returns: slot and collateral needed by a new resting order, including nonzero notional.
pub fn order_terms(
    book: &SharedBook,
    outcome: SharedOutcome,
    side: OrderSide,
    price: u64,
    quantity: u64,
) -> Result<(usize, u64)> {
    let slot = book.slot(outcome, side)?;
    require!(
        price > 0 && book.price_tick > 0 && price.is_multiple_of(book.price_tick),
        order::PriceNotOnTick
    );
    require!(
        quantity > 0 && book.quantity_lot > 0 && quantity.is_multiple_of(book.quantity_lot),
        order::QuantityNotOnLot
    );
    if book.kind == MarketKind::Prediction {
        require!(
            price < book.payout_per_contract,
            prediction::InvalidPredictionOrderPrice
        );
    }
    let notional = quote_amount(book, price, quantity)?;
    require!(notional > 0, order::OrderNotionalTooSmall);
    Ok((
        slot,
        if side == OrderSide::Bid {
            notional
        } else {
            quantity
        },
    ))
}

/// Inputs: raw price/quantity and immutable precision. Errors: scale/result overflow.
/// Returns: floor(price * base_atoms / 10^base_decimals); prediction uses whole contracts.
pub fn quote_amount(book: &SharedBook, price: u64, quantity: u64) -> Result<u64> {
    let scale = 10_u128
        .checked_pow(u32::from(book.base_decimals))
        .ok_or(order::OrderNotionalOverflow)?;
    let amount = u128::from(price)
        .checked_mul(u128::from(quantity))
        .ok_or(order::OrderNotionalOverflow)?
        / scale;
    u64::try_from(amount).map_err(|_| error!(order::OrderNotionalOverflow))
}

/// Inputs: asset account and expected owner/mint. Errors: wrong binding/PDA. Returns: validated claim.
pub fn asset(account: &Account<AssetBalance>, owner: Pubkey, mint: Pubkey) -> Result<()> {
    require!(
        account.owner == owner && account.mint == mint,
        shared::InvalidAssetBalance
    );
    require_keys_eq!(
        account.key(),
        Pubkey::find_program_address(
            &[ASSET_BALANCE_SEED, owner.as_ref(), mint.as_ref()],
            &crate::ID
        )
        .0,
        shared::InvalidAssetBalance
    );
    Ok(())
}

/// Inputs: a trader's cash and optional base/position accounts. Errors: wrong or redundant bindings.
/// Returns: success for exactly the accounts required by this settlement model.
pub fn trader(
    book: &SharedBook,
    owner: Pubkey,
    base: Option<&Account<AssetBalance>>,
    quote: &Account<AssetBalance>,
    position: Option<&Account<PredictionPosition>>,
) -> Result<()> {
    asset(quote, owner, book.quote_mint)?;
    if book.kind == MarketKind::Spot {
        asset(
            base.ok_or(shared::InvalidAssetBalance)?,
            owner,
            book.base_mint,
        )?;
        require!(position.is_none(), shared::InvalidAssetBalance);
    } else {
        require!(base.is_none(), shared::InvalidAssetBalance);
        let p = position.ok_or(shared::InvalidAssetBalance)?;
        require!(
            p.owner == owner && p.market == book.market,
            shared::InvalidAssetBalance
        );
        require_keys_eq!(
            p.key(),
            Pubkey::find_program_address(
                &[
                    PREDICTION_POSITION_SEED,
                    book.market.as_ref(),
                    owner.as_ref()
                ],
                &crate::ID
            )
            .0,
            shared::InvalidAssetBalance
        );
    }
    Ok(())
}

/// Inputs: model/outcome and mutable trader claims. Errors: missing or mismatched base claims.
/// Returns: the selected base/outcome free+locked buckets; cash is handled by its mint ledger.
pub fn base_buckets<'a, 'info>(
    kind: MarketKind,
    outcome: SharedOutcome,
    base: Option<&'a mut Account<'info, AssetBalance>>,
    position: Option<&'a mut Account<'info, PredictionPosition>>,
) -> Result<(&'a mut u64, &'a mut u64)> {
    match (kind, outcome) {
        (MarketKind::Spot, SharedOutcome::Spot) => {
            let value: &mut AssetBalance = base.ok_or(shared::InvalidAssetBalance)?;
            Ok((&mut value.free, &mut value.locked))
        }
        (MarketKind::Prediction, SharedOutcome::Yes) => {
            let value: &mut PredictionPosition = position.ok_or(shared::InvalidAssetBalance)?;
            Ok((&mut value.yes_free, &mut value.yes_locked))
        }
        (MarketKind::Prediction, SharedOutcome::No) => {
            let value: &mut PredictionPosition = position.ok_or(shared::InvalidAssetBalance)?;
            Ok((&mut value.no_free, &mut value.no_locked))
        }
        _ => err!(shared::SharedMarketKindMismatch),
    }
}

/// Inputs: free/locked bucket and positive lock atoms. Errors: funds/overflow. Returns: conserved lock.
pub fn lock(free: &mut u64, locked: &mut u64, amount: u64) -> Result<()> {
    let new_free = free
        .checked_sub(amount)
        .ok_or(balance::InsufficientFreeBalance)?;
    let new_locked = locked
        .checked_add(amount)
        .ok_or(balance::LockedBalanceOverflow)?;
    *free = new_free;
    *locked = new_locked;
    Ok(())
}

/// Inputs: book address/list/price. Errors: none. Returns: canonical shared price level.
pub fn level_key(book: Pubkey, outcome: SharedOutcome, side: OrderSide, price: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[
            SHARED_LEVEL_SEED,
            book.as_ref(),
            outcome.seed(),
            side.seed(),
            &price.to_le_bytes(),
        ],
        &crate::ID,
    )
    .0
}
/// Inputs: book address/order ID. Errors: none. Returns: canonical shared order.
pub fn order_key(book: Pubkey, id: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[SHARED_ORDER_SEED, book.as_ref(), &id.to_le_bytes()],
        &crate::ID,
    )
    .0
}
/// Inputs: existing level/root. Errors: wrong namespace/list, empty/malformed queue. Returns: validation.
pub fn level(value: &Account<SharedPriceLevel>, book: &Account<SharedBook>) -> Result<()> {
    book.slot(value.outcome, value.side)?;
    require!(
        value.book == book.key()
            && value.market == book.market
            && value.price > 0
            && value.order_count > 0
            && value.total_remaining_quantity > 0
            && value.first_order.is_some()
            && value.last_order.is_some(),
        shared::InvalidSharedNeighbor
    );
    require_keys_eq!(
        value.key(),
        level_key(book.key(), value.outcome, value.side, value.price),
        shared::InvalidSharedNeighbor
    );
    Ok(())
}
/// Inputs: existing order/root. Errors: wrong identity, status, amounts or collateral. Returns: validation.
pub fn order(value: &Account<SharedOrder>, book: &Account<SharedBook>) -> Result<()> {
    book.slot(value.outcome, value.side)?;
    require!(
        value.book == book.key()
            && value.market == book.market
            && value.order_id > 0
            && value.order_id < book.next_order_id
            && value.status == OrderStatus::Open
            && value.remaining_quantity > 0
            && value.remaining_quantity <= value.quantity
            && value.price > 0
            && value.locked_collateral > 0,
        shared::InvalidSharedNeighbor
    );
    require_keys_eq!(
        value.key(),
        order_key(book.key(), value.order_id),
        shared::InvalidSharedNeighbor
    );
    require_keys_eq!(
        value.price_level,
        level_key(book.key(), value.outcome, value.side, value.price),
        shared::InvalidSharedNeighbor
    );
    let minimum = if value.side == OrderSide::Bid {
        quote_amount(book, value.price, value.remaining_quantity)?
    } else {
        value.remaining_quantity
    };
    require!(
        if value.side == OrderSide::Bid {
            value.locked_collateral >= minimum
        } else {
            value.locked_collateral == minimum
        },
        shared::InvalidSharedNeighbor
    );
    Ok(())
}

/// Removes one complete open order and repairs its FIFO/price links.
///
/// # Inputs
/// Root, unchanged order snapshot, containing level, exact optional neighbors and original rent
/// recipient when the level becomes empty. Caller separately refunds/settles the locked claim.
/// # Errors
/// Broken identities, skipped links, underflow, redundant hints or a redirected rent refund.
/// # Returns
/// `Ok(())` with one fewer open order; final levels close and the best head advances atomically.
#[allow(clippy::too_many_arguments)]
pub fn remove_order<'info>(
    book: &mut Account<'info, SharedBook>,
    removed: &Account<'info, SharedOrder>,
    current: &mut Account<'info, SharedPriceLevel>,
    mut previous: Option<&mut Account<'info, SharedOrder>>,
    mut next: Option<&mut Account<'info, SharedOrder>>,
    mut better: Option<&mut Account<'info, SharedPriceLevel>>,
    mut worse: Option<&mut Account<'info, SharedPriceLevel>>,
    recipient: Option<&UncheckedAccount<'info>>,
) -> Result<()> {
    order(removed, book)?;
    level(current, book)?;
    require!(
        removed.price_level == current.key()
            && removed.price == current.price
            && removed.outcome == current.outcome
            && removed.side == current.side,
        shared::InvalidSharedNeighbor
    );
    let slot = book.slot(removed.outcome, removed.side)?;
    let best = book.best_prices[slot].ok_or(shared::InvalidSharedBook)?;
    require!(
        (best == current.price) == current.better_price.is_none()
            && match removed.side {
                OrderSide::Bid => best >= current.price,
                OrderSide::Ask => best <= current.price,
            },
        shared::InvalidSharedNeighbor
    );
    require!(
        previous.as_ref().map(|o| o.key()) == removed.previous_order
            && next.as_ref().map(|o| o.key()) == removed.next_order,
        shared::InvalidSharedNeighbor
    );
    require!(
        (current.first_order == Some(removed.key())) == removed.previous_order.is_none()
            && (current.last_order == Some(removed.key())) == removed.next_order.is_none(),
        shared::InvalidSharedNeighbor
    );
    if let Some(value) = previous.as_ref() {
        order(value, book)?;
        require!(
            value.key() != removed.key()
                && value.price_level == current.key()
                && value.outcome == removed.outcome
                && value.side == removed.side
                && value.price == removed.price
                && value.next_order == Some(removed.key())
                && value.order_id < removed.order_id,
            shared::InvalidSharedNeighbor
        );
    }
    if let Some(value) = next.as_ref() {
        order(value, book)?;
        require!(
            value.key() != removed.key()
                && value.price_level == current.key()
                && value.outcome == removed.outcome
                && value.side == removed.side
                && value.price == removed.price
                && value.previous_order == Some(removed.key())
                && value.order_id > removed.order_id,
            shared::InvalidSharedNeighbor
        );
    }
    let count = current
        .order_count
        .checked_sub(1)
        .ok_or(shared::InvalidSharedBook)?;
    let total = current
        .total_remaining_quantity
        .checked_sub(removed.remaining_quantity)
        .ok_or(shared::InvalidSharedBook)?;
    let open = book
        .open_order_count
        .checked_sub(1)
        .ok_or(shared::InvalidSharedBook)?;
    if count == 0 {
        require!(
            previous.is_none() && next.is_none() && total == 0,
            shared::InvalidSharedNeighbor
        );
        require!(
            better.as_ref().map(|v| v.key())
                == current.better_price.map(|p| level_key(
                    book.key(),
                    removed.outcome,
                    removed.side,
                    p
                ))
                && worse.as_ref().map(|v| v.key())
                    == current.worse_price.map(|p| level_key(
                        book.key(),
                        removed.outcome,
                        removed.side,
                        p
                    )),
            shared::InvalidSharedNeighbor
        );
        if let Some(value) = better.as_ref() {
            level(value, book)?;
            require!(
                value.outcome == removed.outcome
                    && value.side == removed.side
                    && value.worse_price == Some(current.price)
                    && match removed.side {
                        OrderSide::Bid => value.price > current.price,
                        OrderSide::Ask => value.price < current.price,
                    },
                shared::InvalidSharedNeighbor
            );
        }
        if let Some(value) = worse.as_ref() {
            level(value, book)?;
            require!(
                value.outcome == removed.outcome
                    && value.side == removed.side
                    && value.better_price == Some(current.price)
                    && match removed.side {
                        OrderSide::Bid => value.price < current.price,
                        OrderSide::Ask => value.price > current.price,
                    },
                shared::InvalidSharedNeighbor
            );
        }
        let rent = recipient.ok_or(shared::InvalidSharedNeighbor)?;
        require_keys_eq!(
            rent.key(),
            current.rent_payer,
            shared::InvalidSharedNeighbor
        );
    } else {
        require!(
            total > 0
                && (previous.is_some() || next.is_some())
                && better.is_none()
                && worse.is_none()
                && recipient.is_none(),
            shared::InvalidSharedNeighbor
        );
    }
    if let Some(value) = previous.as_mut() {
        value.next_order = removed.next_order;
    } else {
        current.first_order = removed.next_order;
    }
    if let Some(value) = next.as_mut() {
        value.previous_order = removed.previous_order;
    } else {
        current.last_order = removed.previous_order;
    }
    current.order_count = count;
    current.total_remaining_quantity = total;
    if count == 0 {
        if let Some(value) = better.as_mut() {
            value.worse_price = current.worse_price;
        } else {
            book.best_prices[slot] = current.worse_price;
        }
        if let Some(value) = worse.as_mut() {
            value.better_price = current.better_price;
        }
        current.close(
            recipient
                .ok_or(shared::InvalidSharedNeighbor)?
                .to_account_info(),
        )?;
    }
    book.open_order_count = open;
    Ok(())
}
