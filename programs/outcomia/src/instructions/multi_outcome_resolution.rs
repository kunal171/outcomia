//! Multi-outcome resolution instructions. The lifecycle rules shared with
//! binary markets live in [`crate::resolution`]; this module adds the
//! outcome-ID check for the market's frozen outcome list and emits events.
use crate::{constants::*, errors::admin, resolution, state::*};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ResolveMultiOutcome<'info> {
    pub resolver: Signer<'info>,
    #[account(mut, seeds = [MULTI_OUTCOME_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(seeds = [ADMIN_SEED, resolver.key().as_ref()], bump = admin_record.bump,
        constraint = admin_record.authority == resolver.key() @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Account<'info, AdminRecord>,
}
#[derive(Accounts)]
pub struct AdvanceMultiOutcome<'info> {
    #[account(mut, seeds = [MULTI_OUTCOME_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
}

/// Publishes or corrects an evidence-backed outcome; corrections restart the entire delay.
/// # Inputs
/// Active admin/resolver, market, outcome, bounded evidence URI/hash, correction flag.
/// # Errors
/// Wrong resolver/window/state, outcome outside the market's list, matured
/// proposal, invalid evidence or timestamp overflow.
/// # Returns
/// Proposed state with one complete replacement proposal; no funds move.
pub fn handle_propose_multi_outcome(
    ctx: Context<ResolveMultiOutcome>,
    outcome: MultiOutcomeResolution,
    evidence_uri: String,
    evidence_hash: [u8; 32],
    correction: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let resolver = ctx.accounts.resolver.key();
    let key = ctx.accounts.market.key();
    let m: &mut MultiOutcomeMarket = &mut ctx.accounts.market;
    resolution::resolver_window(m, resolver, now)?;
    let count = crate::multi_outcome::MultiOutcomeEconomics::from_terms(&m.terms)?.outcome_count;
    require!(
        outcome.is_valid_for(count),
        crate::errors::multi_outcome::InvalidMultiOutcomeId
    );
    resolution::check_proposal_state(m, now, correction)?;
    resolution::validate_evidence(&evidence_uri, &evidence_hash)?;
    m.proposal = Some(MultiOutcomeProposal {
        outcome,
        proposed_at: now,
        evidence_uri,
        evidence_hash,
    });
    resolution::mark_proposed(m)?;
    emit!(crate::MultiOutcomeResolutionEvent {
        market: key,
        outcome: Some(outcome),
        status: m.status
    });
    Ok(())
}
/// Advances a published clock without choosing an arbitrary outcome.
/// # Inputs
/// Canonical market and action: 0 freeze at cutoff, 1 activate fallback,
/// 2 finalize mature proposal, 3 finalize the precommitted Invalid timeout.
/// # Errors
/// Wrong phase/status, missing proposal/fallback, immature delay or missing/early deadline.
/// # Returns
/// One monotonic lifecycle transition; no SPL transfer and no admin override.
pub fn handle_advance_multi_outcome(ctx: Context<AdvanceMultiOutcome>, action: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let key = ctx.accounts.market.key();
    let m: &mut MultiOutcomeMarket = &mut ctx.accounts.market;
    resolution::advance(m, action, now)?;
    emit!(crate::MultiOutcomeResolutionEvent {
        market: key,
        outcome: m.final_outcome,
        status: m.status
    });
    Ok(())
}
