//! Pure deterministic calculations used by the matching engine.
//!
//! This module does not read or modify Solana accounts. Keeping matching math
//! separate lets us verify price crossing, fill quantity, and fixed-point
//! arithmetic before introducing account mutations.

use anchor_lang::prelude::*;

use crate::{
    errors::{market, matching, order},
    state::OrderSide,
};

/// Rejects spot increments that could leave a resting order impossible to fill.
///
/// A fill whose quote value floors to zero is rejected, and only the FIFO head
/// at the best price can be matched. If a partial fill leaves such a remainder
/// at the head, its whole price level and every worse level freeze until the
/// maker cancels.
///
/// Every executable fill uses an on-tick price of at least `tick` and a
/// lot-multiple quantity of at least `lot`. Requiring
/// `tick * lot >= 10^base_decimals` therefore guarantees
/// `floor(price * quantity / 10^base_decimals) >= 1` for every possible fill.
///
/// Example: with 9 base decimals, tick 1 and lot 1, a one-atom remainder at
/// price 1000 is worth floor(1000 / 1e9) = 0 quote atoms and is rejected here.
/// Tick 10,000 and lot 100,000 (product 1e9) is accepted.
///
/// # Inputs
/// Base-mint decimals and raw tick/lot increments.
///
/// # Errors
/// `InvalidPriceTickSize`/`InvalidQuantityLotSize` for zero increments, or
/// `SpotIncrementsTooFine` when the product is below one whole base token or the
/// decimal scale is unrepresentable.
///
/// # Returns
/// `Ok(())` when every possible fill moves at least one quote atom.
pub fn validate_spot_increments(
    base_decimals: u8,
    price_tick: u64,
    quantity_lot: u64,
) -> Result<()> {
    require!(price_tick > 0, market::InvalidPriceTickSize);
    require!(quantity_lot > 0, market::InvalidQuantityLotSize);

    let scale = 10_u128
        .checked_pow(u32::from(base_decimals))
        .ok_or(market::SpotIncrementsTooFine)?;

    // u64 * u64 always fits in u128.
    require!(
        u128::from(price_tick) * u128::from(quantity_lot) >= scale,
        market::SpotIncrementsTooFine
    );
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FillCalculation {
    /// Base-mint atoms exchanged.
    pub base_quantity: u64,

    /// Quote-mint atoms exchanged at the maker's price.
    pub quote_quantity: u64,

    /// Resting maker price used for execution.
    pub execution_price: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettlementPlan {
    /// Deterministic base/quote amounts executed at the maker price.
    pub fill: FillCalculation,

    /// Amount removed from the maker's locked balance and order collateral.
    pub maker_locked_debit: u64,

    /// Rounding remainder returned to the maker when a bid is fully filled.
    pub maker_quote_refund: u64,

    pub maker_fully_filled: bool,
    pub taker_fully_filled: bool,
}

/// Returns whether an incoming taker limit accepts the resting maker price.
///
/// Bids cross asks priced at or below their limit.
/// Asks cross bids priced at or above their limit.
///
/// # Inputs
/// Taker side, raw taker limit and raw maker price in the same quote-price units.
///
/// # Errors
/// None; no validation or account access occurs.
///
/// # Returns
/// `true` for buy limit >= sell price, or sell limit <= buy price; otherwise `false`.
pub fn prices_cross(taker_side: OrderSide, taker_limit_price: u64, maker_price: u64) -> bool {
    match taker_side {
        OrderSide::Bid => taker_limit_price >= maker_price,
        OrderSide::Ask => taker_limit_price <= maker_price,
    }
}

/// Calculates one fill against one resting maker.
///
/// Execution always occurs at the maker's price. The smaller remaining
/// quantity determines whether the maker or taker is completely filled.
///
/// # Calculation
/// `base_fill = min(taker_remaining, maker_remaining)` and
/// `quote_fill = floor(maker_price * base_fill / 10^base_decimals)`.
/// With six base decimals, price 25,000,000 and fill 2,000,000 base atoms
/// give 50,000,000 quote atoms. If quote also has six decimals, that is
/// 2 base tokens for 50 quote tokens. Quote decimals are already represented
/// in the price; multiplying by their scale again would overcharge the fill.
///
/// # Inputs
/// Maker price in quote atoms per whole base token; taker/maker remaining base atoms; base-mint
/// decimals.
///
/// # Errors
/// Zero fill quantity, quote notional rounded to zero, decimal-scale overflow or a result exceeding
/// u64.
///
/// # Returns
/// `Ok(FillCalculation)` with minimum remaining base quantity and floor-divided quote quantity;
/// fees are calculated separately.
pub fn calculate_fill(
    maker_price: u64,
    taker_remaining: u64,
    maker_remaining: u64,
    base_decimals: u8,
) -> Result<FillCalculation> {
    let base_quantity = taker_remaining.min(maker_remaining);

    require!(base_quantity > 0, order::InvalidQuantity);

    let base_scale = 10_u128
        .checked_pow(u32::from(base_decimals))
        .ok_or(order::OrderNotionalOverflow)?;

    let quote_quantity = u128::from(maker_price)
        .checked_mul(u128::from(base_quantity))
        .ok_or(order::OrderNotionalOverflow)?
        .checked_div(base_scale)
        .ok_or(order::OrderNotionalOverflow)?;

    require!(quote_quantity > 0, order::OrderNotionalTooSmall);

    let quote_quantity =
        u64::try_from(quote_quantity).map_err(|_| error!(order::OrderNotionalOverflow))?;

    Ok(FillCalculation {
        base_quantity,
        quote_quantity,
        execution_price: maker_price,
    })
}

#[allow(clippy::too_many_arguments)]
/// Plans one maker-price settlement, including final bid rounding dust.
///
/// Example: at base scale 10, price 15 and total quantity 2 lock 3 quote atoms.
/// Two separate one-unit fills each cost floor(15 / 10) = 1 atom. After the
/// first fill, 2 remain locked; the last fill pays 1 and refunds the final 1
/// to the maker. Refunding only on completion keeps partial orders funded.
///
/// # Inputs
/// Taker side/limit/remaining, maker side/price/remaining/recorded lock and base decimals.
/// Quantities are base atoms.
///
/// # Errors
/// Same-side or noncrossing orders, invalid fill math, mismatched ask backing or insufficient bid
/// backing.
///
/// # Returns
/// `Ok(SettlementPlan)` with executed amounts, completion flags, maker locked debit and any final
/// bid rounding refund.
pub fn calculate_settlement(
    taker_side: OrderSide,
    taker_limit_price: u64,
    taker_remaining: u64,
    maker_side: OrderSide,
    maker_price: u64,
    maker_remaining: u64,
    maker_locked_collateral: u64,
    base_decimals: u8,
) -> Result<SettlementPlan> {
    // A match must always consume liquidity from the opposite side. Checking
    // this before price crossing avoids interpreting a same-side price as a
    // valid trade.
    require!(taker_side != maker_side, matching::MatchingSameSide);

    require!(
        prices_cross(taker_side, taker_limit_price, maker_price),
        matching::OrdersDoNotCross
    );

    let fill = calculate_fill(maker_price, taker_remaining, maker_remaining, base_decimals)?;

    let maker_fully_filled = fill.base_quantity == maker_remaining;
    let taker_fully_filled = fill.base_quantity == taker_remaining;

    let (maker_locked_debit, maker_quote_refund) = match maker_side {
        OrderSide::Ask => {
            // Ask collateral is denominated directly in base atoms, so it must
            // always equal the remaining order quantity. Unlike bid collateral,
            // no fixed-point rounding dust is possible.
            require!(
                maker_locked_collateral == maker_remaining,
                matching::InvalidMakerCollateral
            );

            (fill.base_quantity, 0)
        }

        OrderSide::Bid => {
            // Partial bid fills consume only their calculated quote amount. On
            // the final fill, consume everything still attached to the order
            // and return any accumulated floor-division dust to quote_free.
            let locked_debit = if maker_fully_filled {
                maker_locked_collateral
            } else {
                fill.quote_quantity
            };

            require!(
                locked_debit >= fill.quote_quantity && maker_locked_collateral >= locked_debit,
                matching::InvalidMakerCollateral
            );

            (locked_debit, locked_debit - fill.quote_quantity)
        }
    };

    Ok(SettlementPlan {
        fill,
        maker_locked_debit,
        maker_quote_refund,
        maker_fully_filled,
        taker_fully_filled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE_DECIMALS: u8 = 6;
    const MAKER_PRICE: u64 = 25_000_000;

    #[test]
    fn spot_increments_must_cover_one_whole_base_token() {
        // Exactly one whole base token is the boundary and is accepted.
        assert!(validate_spot_increments(9, 10_000, 100_000).is_ok());
        assert!(validate_spot_increments(6, 1, 1_000_000).is_ok());
        assert!(validate_spot_increments(0, 1, 1).is_ok());
        // One unit below the boundary is rejected.
        assert!(validate_spot_increments(9, 1, 1).is_err());
        assert!(validate_spot_increments(9, 10_000, 99_999).is_err());
        assert!(validate_spot_increments(6, 1, 999_999).is_err());
    }

    #[test]
    fn zero_spot_increments_are_rejected() {
        assert!(validate_spot_increments(6, 0, 1_000_000).is_err());
        assert!(validate_spot_increments(6, 1_000_000, 0).is_err());
    }

    #[test]
    fn unrepresentable_decimal_scale_is_rejected() {
        assert!(validate_spot_increments(u8::MAX, u64::MAX, u64::MAX).is_err());
    }

    #[test]
    fn largest_increments_do_not_overflow() {
        assert!(validate_spot_increments(19, u64::MAX, u64::MAX).is_ok());
    }

    #[test]
    fn accepted_increments_never_produce_a_zero_value_fill() {
        // Exhaustively check small on-tick prices and lot-multiple fills for
        // boundary configurations: every fill must move at least one quote atom.
        for (decimals, tick, lot) in [(9_u8, 10_000_u64, 100_000_u64), (6, 3, 333_334), (2, 7, 15)]
        {
            validate_spot_increments(decimals, tick, lot).unwrap();
            for price_steps in 1..=20 {
                for lot_steps in 1..=20 {
                    let quantity = lot * lot_steps;
                    let fill = calculate_fill(tick * price_steps, quantity, quantity, decimals)
                        .expect("accepted increments must price every fill");
                    assert!(fill.quote_quantity > 0);
                }
            }
        }
    }

    #[test]
    fn rejected_increments_admit_a_zero_value_fill() {
        // The configuration from the original report: one atom at a tiny price.
        assert!(validate_spot_increments(9, 1, 1).is_err());
        assert!(calculate_fill(1_000, 1, 1, 9).is_err());
    }

    #[test]
    fn bid_crosses_equal_or_lower_ask_price() {
        assert!(prices_cross(OrderSide::Bid, 25, 25));
        assert!(prices_cross(OrderSide::Bid, 25, 24));
        assert!(!prices_cross(OrderSide::Bid, 25, 26));
    }

    #[test]
    fn ask_crosses_equal_or_higher_bid_price() {
        assert!(prices_cross(OrderSide::Ask, 25, 25));
        assert!(prices_cross(OrderSide::Ask, 25, 26));
        assert!(!prices_cross(OrderSide::Ask, 25, 24));
    }

    #[test]
    fn equal_remaining_quantities_fill_both_orders() {
        let fill = calculate_fill(MAKER_PRICE, 2_000_000, 2_000_000, BASE_DECIMALS).unwrap();

        assert_eq!(fill.base_quantity, 2_000_000);
        assert_eq!(fill.quote_quantity, 50_000_000);
        assert_eq!(fill.execution_price, MAKER_PRICE);
    }

    #[test]
    fn smaller_maker_is_fully_filled() {
        let fill = calculate_fill(MAKER_PRICE, 5_000_000, 2_000_000, BASE_DECIMALS).unwrap();

        assert_eq!(fill.base_quantity, 2_000_000);
        assert_eq!(fill.quote_quantity, 50_000_000);
    }

    #[test]
    fn smaller_taker_is_fully_filled_and_maker_remains() {
        let fill = calculate_fill(MAKER_PRICE, 2_000_000, 5_000_000, BASE_DECIMALS).unwrap();

        assert_eq!(fill.base_quantity, 2_000_000);
        assert_eq!(fill.quote_quantity, 50_000_000);
    }

    #[test]
    fn execution_uses_maker_price_not_taker_limit() {
        let taker_limit = 30_000_000;
        assert!(prices_cross(OrderSide::Bid, taker_limit, MAKER_PRICE));

        let fill = calculate_fill(MAKER_PRICE, 1_000_000, 1_000_000, BASE_DECIMALS).unwrap();

        assert_eq!(fill.execution_price, MAKER_PRICE);
        assert_ne!(fill.execution_price, taker_limit);
    }

    #[test]
    fn zero_remaining_quantity_is_rejected() {
        assert!(calculate_fill(MAKER_PRICE, 0, 1_000_000, BASE_DECIMALS).is_err());
        assert!(calculate_fill(MAKER_PRICE, 1_000_000, 0, BASE_DECIMALS).is_err());
    }

    #[test]
    fn fill_that_rounds_to_zero_quote_atoms_is_rejected() {
        assert!(calculate_fill(1, 1, 1, 9).is_err());
    }

    #[test]
    fn decimal_scale_overflow_is_rejected() {
        assert!(calculate_fill(1, 1, 1, 39).is_err());
    }

    #[test]
    fn quote_quantity_larger_than_u64_is_rejected() {
        assert!(calculate_fill(u64::MAX, 2, 2, 0).is_err());
    }

    #[test]
    fn same_side_orders_cannot_settle() {
        let bid_result = calculate_settlement(
            OrderSide::Bid,
            30_000_000,
            1_000_000,
            OrderSide::Bid,
            MAKER_PRICE,
            1_000_000,
            25_000_000,
            BASE_DECIMALS,
        );
        let ask_result = calculate_settlement(
            OrderSide::Ask,
            20_000_000,
            1_000_000,
            OrderSide::Ask,
            MAKER_PRICE,
            1_000_000,
            1_000_000,
            BASE_DECIMALS,
        );

        assert!(bid_result.is_err());
        assert!(ask_result.is_err());
    }

    #[test]
    fn non_crossing_bid_and_ask_cannot_settle() {
        let bid_below_ask = calculate_settlement(
            OrderSide::Bid,
            24_000_000,
            1_000_000,
            OrderSide::Ask,
            MAKER_PRICE,
            1_000_000,
            1_000_000,
            BASE_DECIMALS,
        );
        let ask_above_bid = calculate_settlement(
            OrderSide::Ask,
            26_000_000,
            1_000_000,
            OrderSide::Bid,
            MAKER_PRICE,
            1_000_000,
            25_000_000,
            BASE_DECIMALS,
        );

        assert!(bid_below_ask.is_err());
        assert!(ask_above_bid.is_err());
    }

    #[test]
    fn incoming_bid_partially_fills_maker_ask() {
        let plan = calculate_settlement(
            OrderSide::Bid,
            30_000_000,
            2_000_000,
            OrderSide::Ask,
            MAKER_PRICE,
            5_000_000,
            5_000_000,
            BASE_DECIMALS,
        )
        .unwrap();

        assert_eq!(plan.fill.base_quantity, 2_000_000);
        assert_eq!(plan.fill.quote_quantity, 50_000_000);
        assert_eq!(plan.maker_locked_debit, 2_000_000);
        assert_eq!(plan.maker_quote_refund, 0);
        assert!(!plan.maker_fully_filled);
        assert!(plan.taker_fully_filled);
    }

    #[test]
    fn incoming_ask_partially_fills_maker_bid() {
        let plan = calculate_settlement(
            OrderSide::Ask,
            20_000_000,
            2_000_000,
            OrderSide::Bid,
            MAKER_PRICE,
            5_000_000,
            125_000_000,
            BASE_DECIMALS,
        )
        .unwrap();

        assert_eq!(plan.fill.base_quantity, 2_000_000);
        assert_eq!(plan.fill.quote_quantity, 50_000_000);
        assert_eq!(plan.maker_locked_debit, 50_000_000);
        assert_eq!(plan.maker_quote_refund, 0);
        assert!(!plan.maker_fully_filled);
        assert!(plan.taker_fully_filled);
    }

    #[test]
    fn smaller_maker_sets_only_maker_filled_flag() {
        let plan = calculate_settlement(
            OrderSide::Bid,
            30_000_000,
            5_000_000,
            OrderSide::Ask,
            MAKER_PRICE,
            2_000_000,
            2_000_000,
            BASE_DECIMALS,
        )
        .unwrap();

        assert!(plan.maker_fully_filled);
        assert!(!plan.taker_fully_filled);
    }

    #[test]
    fn equal_quantities_fill_both_maker_and_taker() {
        let plan = calculate_settlement(
            OrderSide::Bid,
            30_000_000,
            2_000_000,
            OrderSide::Ask,
            MAKER_PRICE,
            2_000_000,
            2_000_000,
            BASE_DECIMALS,
        )
        .unwrap();

        assert!(plan.maker_fully_filled);
        assert!(plan.taker_fully_filled);
    }

    #[test]
    fn final_maker_bid_fill_refunds_rounding_dust() {
        // With one base decimal, a price of 15 and quantity of one executes for
        // floor(15 / 10) = 1 quote atom. Two locked atoms model one atom of
        // rounding dust accumulated across earlier partial fills.
        let plan =
            calculate_settlement(OrderSide::Ask, 15, 1, OrderSide::Bid, 15, 1, 2, 1).unwrap();

        assert_eq!(plan.fill.quote_quantity, 1);
        assert_eq!(plan.maker_locked_debit, 2);
        assert_eq!(plan.maker_quote_refund, 1);
        assert!(plan.maker_fully_filled);
        assert!(plan.taker_fully_filled);
    }

    #[test]
    fn partial_maker_bid_requires_enough_locked_quote() {
        let result = calculate_settlement(
            OrderSide::Ask,
            20_000_000,
            2_000_000,
            OrderSide::Bid,
            MAKER_PRICE,
            5_000_000,
            49_999_999,
            BASE_DECIMALS,
        );

        assert!(result.is_err());
    }

    #[test]
    fn maker_ask_collateral_must_equal_remaining_quantity() {
        let insufficient = calculate_settlement(
            OrderSide::Bid,
            30_000_000,
            2_000_000,
            OrderSide::Ask,
            MAKER_PRICE,
            5_000_000,
            4_999_999,
            BASE_DECIMALS,
        );
        let excess = calculate_settlement(
            OrderSide::Bid,
            30_000_000,
            2_000_000,
            OrderSide::Ask,
            MAKER_PRICE,
            5_000_000,
            5_000_001,
            BASE_DECIMALS,
        );

        assert!(insufficient.is_err());
        assert!(excess.is_err());
    }
}
