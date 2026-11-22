//! Resolution of binary club markets.
//!
//! Any current club admin may propose or correct, under the market's
//! published schedule: the same earliest time, review delay and per-phase
//! correction deadline as public markets. Club markets have no fallback, so
//! if an admin leaves, any remaining admin resolves. Finalization stays
//! permissionless. Protocol admins have no role here.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::club, resolution, state::*};

#[derive(Accounts)]
pub struct ProposeClubPrediction<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump = club_market.bump,
        has_one = market @ club::InvalidClubMarket)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    #[account(mut, seeds = [CLUB_PREDICTION_MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(seeds = [CLUB_MEMBER_SEED, club_market.club.as_ref(), admin.key().as_ref()],
        bump = admin_member.bump,
        constraint = admin_member.role == ClubRole::Admin @ club::UnauthorizedClubAdmin)]
    pub admin_member: Box<Account<'info, ClubMember>>,
}

#[derive(Accounts)]
pub struct AdvanceClubPrediction<'info> {
    #[account(mut, seeds = [CLUB_PREDICTION_MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
}

/// Publishes or corrects an evidence-backed outcome; corrections restart the delay.
///
/// # Inputs
/// A current club admin, the club market, outcome, evidence URI and hash, correction flag.
/// # Errors
/// Signer is not an admin of the market's club, the window is not open or has closed, the
/// state does not accept this proposal, or evidence is invalid.
/// # Returns
/// Proposed state with one complete replacement proposal; no funds move.
pub fn handle_propose_club_prediction(
    ctx: Context<ProposeClubPrediction>,
    outcome: PredictionResolution,
    evidence_uri: String,
    evidence_hash: [u8; 32],
    correction: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m: &mut PredictionMarket = &mut ctx.accounts.market;
    // Authority comes from the admin record; the stored resolver is passed only
    // so the shared check applies the market's published timing.
    let stored_resolver = m.resolver;
    resolution::resolver_window(m, stored_resolver, now)?;
    resolution::check_proposal_state(m, now, correction)?;
    resolution::validate_evidence(&evidence_uri, &evidence_hash)?;
    m.proposal = Some(PredictionProposal {
        outcome,
        proposed_at: now,
        evidence_uri,
        evidence_hash,
    });
    resolution::mark_proposed(m)
}

/// Advances a published clock: 0 freezes at cutoff, 2 finalizes a mature proposal.
/// Fallback actions fail because club markets have no fallback.
///
/// # Errors
/// Wrong state, missing or immature proposal, or an action needing a fallback.
/// # Returns
/// One monotonic lifecycle transition; no funds move.
pub fn handle_advance_club_prediction(
    ctx: Context<AdvanceClubPrediction>,
    action: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m: &mut PredictionMarket = &mut ctx.accounts.market;
    resolution::advance(m, action, now)
}
