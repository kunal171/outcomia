//! Converts cash into fully backed YES/NO pairs and back, without an SPL CPI.
//!
//! A whole pair costs one winning payout. Tokens stay in the collateral vault;
//! only the claim changes from free cash to reserved backing. Shared writable
//! market totals serialize these operations, trading some parallelism for a
//! simple exact reserve invariant. Orders may later lock outcomes, which are
//! deliberately excluded from merging.
//!
//! With six collateral decimals, payout is 1,000,000 atoms. Splitting 3 pairs
//! moves 3,000,000 from free cash into reserve and creates 3 YES plus 3 NO.
//! It does not need 6 tokens: exactly one side ultimately wins, or each side
//! gets half on Invalid. Merging those free pairs reverses that liability.

use crate::{
    constants::{PREDICTION_MARKET_SEED, PREDICTION_POSITION_SEED},
    errors::{balance, prediction},
    state::{PredictionMarket, PredictionPosition, PredictionStatus},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct PredictionCompleteSet<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut,
        seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = market @ prediction::PredictionPositionMarketMismatch,
        has_one = owner @ prediction::PredictionPositionOwnerMismatch)]
    pub position: Account<'info, PredictionPosition>,
}

/// Converts free cash into equally backed YES and NO claims.
///
/// # Inputs
/// `ctx`: owner position and canonical market; `quantity`: positive whole pairs, not token atoms.
///
/// # Errors
/// Not Open, at/after close, zero quantity, insufficient cash or multiplication/supply/reserve
/// overflow.
///
/// # Returns
/// `Ok(())` after reserving `quantity * payout_per_contract` and issuing equal YES/NO; vault tokens
/// do not move.
pub fn handle_split_prediction_complete_set(
    ctx: Context<PredictionCompleteSet>,
    quantity: u64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(
        market.status == PredictionStatus::Open && Clock::get()?.unix_timestamp < market.close_ts,
        prediction::PredictionSplitUnavailable
    );
    require!(quantity > 0, prediction::InvalidPredictionContractQuantity);
    let cost = quantity
        .checked_mul(market.payout_per_contract)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let position = &mut ctx.accounts.position;
    // Calculate every next value first. This makes the reserve transfer easy
    // to audit and avoids partially updated in-memory accounting on an error.
    let free = position
        .collateral_free
        .checked_sub(cost)
        .ok_or(balance::InsufficientFreeBalance)?;
    let yes = position
        .yes_free
        .checked_add(quantity)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let no = position
        .no_free
        .checked_add(quantity)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let yes_supply = market
        .yes_supply
        .checked_add(quantity)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let no_supply = market
        .no_supply
        .checked_add(quantity)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let reserve = market
        .backing_reserve
        .checked_add(cost)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    position.collateral_free = free;
    position.yes_free = yes;
    position.no_free = no;
    market.yes_supply = yes_supply;
    market.no_supply = no_supply;
    market.backing_reserve = reserve;
    Ok(())
}

/// Returns the fixed collateral backing of free YES/NO pairs.
///
/// # Inputs
/// `ctx`: owner position and canonical market; `quantity`: positive whole free pairs.
///
/// # Errors
/// Status outside Open/Frozen/Proposed, insufficient free pairs, supply/reserve underflow or refund
/// overflow.
///
/// # Returns
/// `Ok(())` after equal YES/NO burns and a reserve-to-free-cash refund; locked contracts are
/// excluded.
pub fn handle_merge_prediction_complete_set(
    ctx: Context<PredictionCompleteSet>,
    quantity: u64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    // Frozen/proposed markets still permit unwinding a complete pair. After
    // resolution redemption uses the actual outcome instead of pair merging.
    require!(
        matches!(
            market.status,
            PredictionStatus::Open | PredictionStatus::Frozen | PredictionStatus::Proposed
        ),
        prediction::PredictionMergeUnavailable
    );
    require!(quantity > 0, prediction::InvalidPredictionContractQuantity);
    // A complete pair has a fixed payout regardless of current book prices.
    // Selling YES at 0.60 is a trade; merging YES+NO releases their full 1.00
    // backing. Allowing a locked leg here would spend the same claim twice.
    let refund = quantity
        .checked_mul(market.payout_per_contract)
        .ok_or(prediction::PredictionAccountingOverflow)?;
    let position = &mut ctx.accounts.position;
    let yes = position
        .yes_free
        .checked_sub(quantity)
        .ok_or(prediction::InsufficientPredictionPositions)?;
    let no = position
        .no_free
        .checked_sub(quantity)
        .ok_or(prediction::InsufficientPredictionPositions)?;
    let free = position
        .collateral_free
        .checked_add(refund)
        .ok_or(balance::FreeBalanceOverflow)?;
    let yes_supply = market
        .yes_supply
        .checked_sub(quantity)
        .ok_or(prediction::PredictionBackingUnderflow)?;
    let no_supply = market
        .no_supply
        .checked_sub(quantity)
        .ok_or(prediction::PredictionBackingUnderflow)?;
    let reserve = market
        .backing_reserve
        .checked_sub(refund)
        .ok_or(prediction::PredictionBackingUnderflow)?;
    position.collateral_free = free;
    position.yes_free = yes;
    position.no_free = no;
    market.yes_supply = yes_supply;
    market.no_supply = no_supply;
    market.backing_reserve = reserve;
    Ok(())
}
