//! Binary resolution instructions. The lifecycle rules shared with
//! multi-outcome markets live in [`crate::resolution`].
use crate::{
    constants::*,
    errors::{admin, prediction, shared},
    resolution,
    state::*,
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ResolvePrediction<'info> {
    pub resolver: Signer<'info>,
    #[account(mut, seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(seeds = [ADMIN_SEED, resolver.key().as_ref()], bump = admin_record.bump,
        constraint = admin_record.authority == resolver.key() @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Account<'info, AdminRecord>,
}
#[derive(Accounts)]
pub struct ProposePrediction<'info> {
    #[account(mut)]
    pub resolver: Signer<'info>,
    #[account(mut, seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(seeds = [ADMIN_SEED, resolver.key().as_ref()], bump = admin_record.bump,
        constraint = admin_record.authority == resolver.key() @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Account<'info, AdminRecord>,
    #[account(seeds = [DISPUTE_CONFIG_SEED], bump = dispute_config.bump)]
    pub dispute_config: Box<Account<'info, DisputeConfig>>,
    #[account(init_if_needed, payer = resolver, space = 8 + MarketDispute::INIT_SPACE,
        seeds = [MARKET_DISPUTE_SEED, market.key().as_ref()], bump)]
    pub dispute: Box<Account<'info, MarketDispute>>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct AdvancePrediction<'info> {
    #[account(mut, seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    /// CHECK: The market's dispute record PDA; empty for proposals made
    /// before disputes existed, which keep the old finalization rule.
    #[account(seeds = [MARKET_DISPUTE_SEED, market.key().as_ref()], bump)]
    pub dispute: UncheckedAccount<'info>,
}

/// Publishes or corrects an evidence-backed outcome; corrections restart the
/// entire delay and the dispute window.
/// # Inputs
/// Active admin/resolver, market, outcome, bounded evidence URI/hash, correction
/// flag, the dispute settings and the market's dispute record (created on the
/// first proposal, fixing the regular dispute window).
/// # Errors
/// Wrong resolver/window/state, matured proposal, invalid evidence, timestamp
/// overflow, or an open dispute.
/// # Returns
/// Proposed state with one complete replacement proposal; no funds move.
pub fn handle_propose_prediction(
    ctx: Context<ProposePrediction>,
    outcome: PredictionResolution,
    evidence_uri: String,
    evidence_hash: [u8; 32],
    correction: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let resolver = ctx.accounts.resolver.key();
    let key = ctx.accounts.market.key();
    super::disputes::prepare_proposal(
        &mut ctx.accounts.dispute,
        key,
        false,
        &ctx.accounts.dispute_config,
        ctx.bumps.dispute,
    )?;
    let m: &mut PredictionMarket = &mut ctx.accounts.market;
    resolution::resolver_window(m, resolver, now)?;
    resolution::check_proposal_state(m, now, correction)?;
    resolution::validate_evidence(&evidence_uri, &evidence_hash)?;
    m.proposal = Some(PredictionProposal {
        outcome,
        proposed_at: now,
        evidence_uri,
        evidence_hash,
    });
    resolution::mark_proposed(m)?;
    Ok(())
}
/// Freezes trading administratively; only the active-admin market creator may stop it early.
/// # Inputs
/// Creator signer/admin record and Open market.
/// # Errors
/// Foreign creator or non-Open state.
/// # Returns
/// Frozen market; published resolution clocks and withdrawals remain unchanged.
pub fn handle_close_prediction_trading(ctx: Context<ResolvePrediction>) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.market.authority,
        ctx.accounts.resolver.key(),
        prediction::UnauthorizedPredictionAuthority
    );
    require!(
        ctx.accounts.market.status == PredictionStatus::Open,
        shared::PredictionResolutionUnavailable
    );
    ctx.accounts.market.status = PredictionStatus::Frozen;
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
pub fn handle_advance_prediction(ctx: Context<AdvancePrediction>, action: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let gate = super::disputes::gate(&ctx.accounts.dispute)?;
    let m: &mut PredictionMarket = &mut ctx.accounts.market;
    resolution::advance(m, action, now, gate)
}
