//! Pauses an active market under its stored market authority.
//!
//! Pausing blocks new liquidity but deliberately does not block cancellation;
//! traders must retain an exit path while market administration investigates.

use anchor_lang::prelude::*;

use crate::{
    errors::market,
    events::MarketStatusChangedEvent,
    state::{Market, MarketStatus},
};

#[derive(Accounts)]
pub struct PauseMarket<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority,
        constraint = market.status == MarketStatus::Active @ market::MarketAlreadyPaused
    )]
    pub market: Account<'info, Market>,
}

/// Stops new spot placement and matching under the stored market authority.
///
/// This is a lifecycle change, not account closure: orders, custody and claims
/// stay intact. Cancellation and withdrawal retain their separate owner checks
/// and remain usable while paused; protocol-admin status is not required here.
///
/// # Inputs
/// `ctx`: stored spot-market authority signer and Active market.
///
/// # Errors
/// Wrong authority or `MarketAlreadyPaused` for a non-Active market.
///
/// # Returns
/// `Ok(())` after Active becomes Paused; orders and owner cancellation/withdrawal rights remain.
pub fn handle_pause_market(ctx: Context<PauseMarket>) -> Result<()> {
    // Cancellation has no Active constraint, so this transition freezes only
    // placement and preserves owner-controlled collateral withdrawal.
    ctx.accounts.market.status = MarketStatus::Paused;

    emit!(MarketStatusChangedEvent {
        market: ctx.accounts.market.key(),
        authority: ctx.accounts.authority.key(),
        status: MarketStatus::Paused,
    });

    Ok(())
}
