//! Reactivates a paused market under its stored market authority.
//!
//! The explicit Paused precondition prevents a successful no-op transaction
//! from being mistaken for a real lifecycle transition by clients or operators.

use anchor_lang::prelude::*;

use crate::{
    errors::market,
    events::MarketStatusChangedEvent,
    state::{Market, MarketStatus},
};

#[derive(Accounts)]
pub struct UnpauseMarket<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        constraint = market.status == MarketStatus::Paused @ market::MarketAlreadyActive
    )]
    pub market: Account<'info, Market>,
}

/// Resumes spot trading without resetting IDs, book links or deposited balances.
///
/// The stored market authority signs and the account constraint requires Paused
/// status. Calling this on an already active market fails instead of emitting a
/// misleading second activation event.
///
/// # Inputs
/// `ctx`: stored authority signer and Paused spot market.
///
/// # Errors
/// Wrong authority or `MarketAlreadyActive` for a non-Paused market.
///
/// # Returns
/// `Ok(())` after Paused becomes Active, preserving balances, book links and IDs.
pub fn handle_unpause_market(ctx: Context<UnpauseMarket>) -> Result<()> {
    ctx.accounts.market.status = MarketStatus::Active;

    emit!(MarketStatusChangedEvent {
        market: ctx.accounts.market.key(),
        authority: ctx.accounts.authority.key(),
        status: MarketStatus::Active,
    });

    Ok(())
}
