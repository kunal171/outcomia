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

/// Checks the resolver's published proposal window; an early freeze cannot accelerate it.
/// # Inputs
/// Market, signer key and current Unix seconds.
/// # Errors
/// Trading/earliest time not reached, expired window, or caller not the current resolver.
/// # Returns
/// Success only inside the active resolver's exclusive proposal/correction window.
fn resolver_window(m: &MultiOutcomeMarket, signer: Pubkey, now: i64) -> Result<()> {
    require!(
        now >= m.terms.close_ts
            && now >= m.terms.earliest_resolution_ts.unwrap_or(m.terms.close_ts),
        shared::PredictionResolutionUnavailable
    );
    let expected = match m.resolution_phase {
        PredictionResolutionPhase::Primary => {
            if let Some(f) = &m.terms.fallback {
                require!(now < f.available_ts, shared::PredictionFallbackUnavailable);
            }
            m.terms.resolver
        }
        PredictionResolutionPhase::Fallback => {
            let f = m
                .terms
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
fn maturity(m: &MultiOutcomeMarket) -> Result<i64> {
    let proposal = m
        .proposal
        .as_ref()
        .ok_or(shared::PredictionProposalUnavailable)?;
    proposal
        .proposed_at
        .checked_add(
            i64::try_from(m.terms.resolution_delay_seconds)
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
pub fn handle_propose_multi_outcome(
    ctx: Context<ResolveMultiOutcome>,
    outcome: MultiOutcomeResolution,
    evidence_uri: String,
    evidence_hash: [u8; 32],
    correction: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    resolver_window(m, ctx.accounts.resolver.key(), now)?;
    let count = crate::multi_outcome::MultiOutcomeEconomics::from_terms(&m.terms)?.outcome_count;
    require!(
        outcome.is_valid_for(count),
        crate::errors::multi_outcome::InvalidMultiOutcomeId
    );
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
    m.proposal = Some(MultiOutcomeProposal {
        outcome,
        proposed_at: now,
        evidence_uri,
        evidence_hash,
    });
    // Reject an unrepresentable maturity before the proposal is persisted.
    maturity(m)?;
    m.status = PredictionStatus::Proposed;
    emit!(crate::MultiOutcomeResolutionEvent {
        market: m.key(),
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
    let m = &mut ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;
    require!(
        m.final_outcome.is_none(),
        shared::PredictionResolutionUnavailable
    );
    match action {
        0 => {
            require!(
                m.status == PredictionStatus::Open && now >= m.terms.close_ts,
                shared::PredictionResolutionUnavailable
            );
            m.status = PredictionStatus::Frozen;
        }
        1 => {
            let f = m
                .terms
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
                .terms
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
            m.final_outcome = Some(MultiOutcomeResolution::Invalid);
            m.status = PredictionStatus::Resolved;
        }
        _ => return err!(shared::PredictionResolutionUnavailable),
    }
    emit!(crate::MultiOutcomeResolutionEvent {
        market: m.key(),
        outcome: m.final_outcome,
        status: m.status
    });
    Ok(())
}
