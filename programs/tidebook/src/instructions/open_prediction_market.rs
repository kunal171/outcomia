//! Opens an existing draft under its stored authority without changing terms.
//!
//! Opening requires both the authority fixed at creation and a current active
//! admin record. No other admin or resolver has an override.
//! The strict close-time gate also prevents opening an already expired draft.

use anchor_lang::prelude::*;

use crate::{
    constants::{ADMIN_SEED, PREDICTION_MARKET_SEED},
    errors::{admin, prediction},
    state::{AdminRecord, AdminStatus, PredictionMarket, PredictionStatus},
};

#[derive(Accounts)]
pub struct OpenPredictionMarket<'info> {
    pub authority: Signer<'info>,
    #[account(mut,
        seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump,
        has_one = authority @ prediction::UnauthorizedPredictionAuthority,
        constraint = market.resolver == authority.key() @ prediction::PredictionCreatorMustResolve)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump,
        has_one = authority @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Account<'info, AdminRecord>,
}

pub fn handle_open_prediction_market(ctx: Context<OpenPredictionMarket>) -> Result<()> {
    require!(
        ctx.accounts.market.status == PredictionStatus::Draft,
        prediction::PredictionNotDraft
    );
    require!(
        Clock::get()?.unix_timestamp < ctx.accounts.market.close_ts,
        prediction::PredictionOpeningClosed
    );
    // Opening changes only status. Existing cash, complete-set counters, rule
    // commitments and resolver windows are not reset or rewritten.
    ctx.accounts.market.status = PredictionStatus::Open;
    Ok(())
}
