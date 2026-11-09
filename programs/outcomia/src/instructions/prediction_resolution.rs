//! Resolution changes the payout schedule, never moves customer funds.
//!
//! Only the published resolver, while an active admin, may propose/correct.
//! Finalization is permissionless: revoking an admin cannot trap an already
//! proposed payout. A fallback cannot replace a valid primary proposal.
use crate::{
    constants::*,
    errors::{admin, prediction, shared},
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
pub struct AdvancePrediction<'info> {
    #[account(mut, seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
}

/// Checks the resolver's published proposal window; an early freeze cannot accelerate it.
/// # Inputs
/// Market, signer key and current Unix seconds.
/// # Errors
/// Trading/earliest time not reached, expired window, or caller not the current resolver.
/// # Returns
/// Success only inside the active resolver's exclusive proposal/correction window.
fn resolver_window(m: &PredictionMarket, signer: Pubkey, now: i64) -> Result<()> {
    require!(
        now >= m.close_ts && now >= m.earliest_resolution_ts.unwrap_or(m.close_ts),
        shared::PredictionResolutionUnavailable
    );
    let expected = match m.resolution_phase {
        PredictionResolutionPhase::Primary => {
            if let Some(f) = &m.fallback {
                require!(now < f.available_ts, shared::PredictionFallbackUnavailable);
            }
            m.resolver
        }
        PredictionResolutionPhase::Fallback => {
            let f = m
                .fallback
                .as_ref()
                .ok_or(shared::PredictionFallbackUnavailable)?;
            require!(
                now >= f.available_ts && f.deadline_ts.is_none_or(|end| now < end),
                shared::PredictionFallbackUnavailable
            );
            f.resolver
        }
    };
    require_keys_eq!(expected, signer, shared::UnauthorizedPredictionResolver);
    Ok(())
}
/// Computes the exact maturity without truncating a large unsigned delay.
/// # Inputs
/// Stored proposal and agreed delay seconds.
/// # Errors
/// Timestamp conversion/addition overflow.
/// # Returns
/// First second when correction stops and permissionless finalization starts.
fn maturity(m: &PredictionMarket) -> Result<i64> {
    let proposal = m
        .proposal
        .as_ref()
        .ok_or(shared::PredictionProposalUnavailable)?;
    proposal
        .proposed_at
        .checked_add(
            i64::try_from(m.resolution_delay_seconds)
                .map_err(|_| error!(prediction::PredictionTimestampOverflow))?,
        )
        .ok_or_else(|| error!(prediction::PredictionTimestampOverflow))
}
/// Publishes or corrects an evidence-backed outcome; corrections restart the entire delay.
/// # Inputs
/// Active admin/resolver, market, outcome, bounded evidence URI/hash, correction flag.
/// # Errors
/// Wrong resolver/window/state, matured proposal, invalid evidence or timestamp overflow.
/// # Returns
/// Proposed state with one complete replacement proposal; no funds move.
pub fn handle_propose_prediction(
    ctx: Context<ResolvePrediction>,
    outcome: PredictionResolution,
    evidence_uri: String,
    evidence_hash: [u8; 32],
    correction: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    resolver_window(m, ctx.accounts.resolver.key(), now)?;
    require!(
        m.final_outcome.is_none(),
        shared::PredictionProposalUnavailable
    );
    if correction {
        require!(
            m.status == PredictionStatus::Proposed && now < maturity(m)?,
            shared::PredictionProposalUnavailable
        );
    } else {
        require!(
            matches!(m.status, PredictionStatus::Open | PredictionStatus::Frozen)
                && m.proposal.is_none(),
            shared::PredictionProposalUnavailable
        );
    }
    let target = evidence_uri
        .strip_prefix("ar://")
        .or_else(|| evidence_uri.strip_prefix("https://"));
    require!(
        evidence_uri.len() <= PREDICTION_URI_MAX_LENGTH
            && evidence_uri.bytes().all(|b| b.is_ascii_graphic())
            && target.is_some_and(|s| !s.is_empty())
            && evidence_hash != [0; 32],
        shared::InvalidPredictionEvidence
    );
    m.proposal = Some(PredictionProposal {
        outcome,
        proposed_at: now,
        evidence_uri,
        evidence_hash,
    });
    // Reject an unrepresentable maturity before the proposal is persisted.
    maturity(m)?;
    m.status = PredictionStatus::Proposed;
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
    let m = &mut ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;
    require!(
        m.final_outcome.is_none(),
        shared::PredictionResolutionUnavailable
    );
    match action {
        0 => {
            require!(
                m.status == PredictionStatus::Open && now >= m.close_ts,
                shared::PredictionResolutionUnavailable
            );
            m.status = PredictionStatus::Frozen;
        }
        1 => {
            let f = m
                .fallback
                .as_ref()
                .ok_or(shared::PredictionFallbackUnavailable)?;
            require!(
                matches!(m.status, PredictionStatus::Open | PredictionStatus::Frozen)
                    && m.proposal.is_none()
                    && m.resolution_phase == PredictionResolutionPhase::Primary
                    && now >= f.available_ts
                    && f.deadline_ts.is_none_or(|end| now < end),
                shared::PredictionFallbackUnavailable
            );
            m.status = PredictionStatus::Frozen;
            m.resolution_phase = PredictionResolutionPhase::Fallback;
        }
        2 => {
            require!(
                m.status == PredictionStatus::Proposed && now >= maturity(m)?,
                shared::PredictionProposalUnavailable
            );
            m.final_outcome = Some(
                m.proposal
                    .as_ref()
                    .ok_or(shared::PredictionProposalUnavailable)?
                    .outcome,
            );
            m.status = PredictionStatus::Resolved;
        }
        3 => {
            let end = m
                .fallback
                .as_ref()
                .and_then(|f| f.deadline_ts)
                .ok_or(shared::PredictionFallbackUnavailable)?;
            require!(
                matches!(m.status, PredictionStatus::Open | PredictionStatus::Frozen)
                    && m.proposal.is_none()
                    && now >= end,
                shared::PredictionFallbackUnavailable
            );
            m.resolution_phase = PredictionResolutionPhase::Fallback;
            m.final_outcome = Some(PredictionResolution::Invalid);
            m.status = PredictionStatus::Resolved;
        }
        _ => return err!(shared::PredictionResolutionUnavailable),
    }
    Ok(())
}
