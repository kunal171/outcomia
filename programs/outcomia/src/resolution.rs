//! Resolution lifecycle shared by binary and multi-outcome prediction markets.
//!
//! Both market families publish the same schedule (trading cutoff, earliest
//! resolution time, review delay and optional fallback) and move through the
//! same states. Only their outcome type and storage layout differ, so these
//! rules are written once against [`ResolutionMarket`].
//!
//! Resolution changes the payout schedule; it never moves customer funds.
//! Only the published resolver, while an active admin, may propose or correct
//! (the admin check lives in each instruction's account constraints).
//! Finalization is permissionless, so revoking an admin cannot trap an already
//! proposed payout, and a fallback cannot replace a valid primary proposal.
use anchor_lang::prelude::*;

use crate::{
    errors::{prediction, shared},
    state::{
        MultiOutcomeMarket, MultiOutcomeResolution, PredictionFallback, PredictionMarket,
        PredictionResolution, PredictionResolutionPhase, PredictionStatus,
        PREDICTION_URI_MAX_LENGTH,
    },
};

/// Read/write view of the resolution fields of one market family.
pub trait ResolutionMarket {
    /// Final result stored by this market family.
    type Outcome: Copy;
    /// Result applied when a configured fallback deadline passes unproposed.
    const INVALID: Self::Outcome;

    fn close_ts(&self) -> i64;
    fn earliest_resolution_ts(&self) -> Option<i64>;
    fn resolver(&self) -> Pubkey;
    fn fallback(&self) -> Option<&PredictionFallback>;
    fn resolution_delay_seconds(&self) -> u64;
    fn resolution_phase(&self) -> PredictionResolutionPhase;
    fn set_resolution_phase(&mut self, phase: PredictionResolutionPhase);
    fn status(&self) -> PredictionStatus;
    fn set_status(&mut self, status: PredictionStatus);
    /// Pending proposal as `(outcome, proposed_at)`, if one is stored.
    fn proposal(&self) -> Option<(Self::Outcome, i64)>;
    fn final_outcome(&self) -> Option<Self::Outcome>;
    fn set_final_outcome(&mut self, outcome: Self::Outcome);
}

/// Checks the resolver's published proposal window; an early freeze cannot accelerate it.
/// # Inputs
/// Market, signer key and current Unix seconds.
/// # Errors
/// Trading/earliest time not reached, expired window, or caller not the current resolver.
/// # Returns
/// Success only inside the active resolver's exclusive proposal/correction window.
pub fn resolver_window<M: ResolutionMarket>(m: &M, signer: Pubkey, now: i64) -> Result<()> {
    require!(
        now >= m.close_ts() && now >= m.earliest_resolution_ts().unwrap_or(m.close_ts()),
        shared::PredictionResolutionUnavailable
    );
    let expected = match m.resolution_phase() {
        PredictionResolutionPhase::Primary => {
            if let Some(f) = m.fallback() {
                require!(now < f.available_ts, shared::PredictionFallbackUnavailable);
            }
            m.resolver()
        }
        PredictionResolutionPhase::Fallback => {
            let f = m.fallback().ok_or(shared::PredictionFallbackUnavailable)?;
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
/// Missing proposal, or timestamp conversion/addition overflow.
/// # Returns
/// First second when correction stops and permissionless finalization starts.
pub fn maturity<M: ResolutionMarket>(m: &M) -> Result<i64> {
    let (_, proposed_at) = m.proposal().ok_or(shared::PredictionProposalUnavailable)?;
    proposed_at
        .checked_add(
            i64::try_from(m.resolution_delay_seconds())
                .map_err(|_| error!(prediction::PredictionTimestampOverflow))?,
        )
        .ok_or_else(|| error!(prediction::PredictionTimestampOverflow))
}

/// Checks that the market's lifecycle state accepts a new proposal or a correction.
/// # Inputs
/// Market, current Unix seconds and whether this replaces a pending proposal.
/// # Errors
/// Already final, correcting without a pending/immature proposal, or proposing twice.
/// # Returns
/// Success when the caller may store a (replacement) proposal.
pub fn check_proposal_state<M: ResolutionMarket>(m: &M, now: i64, correction: bool) -> Result<()> {
    require!(
        m.final_outcome().is_none(),
        shared::PredictionProposalUnavailable
    );
    if correction {
        require!(
            m.status() == PredictionStatus::Proposed && now < maturity(m)?,
            shared::PredictionProposalUnavailable
        );
    } else {
        require!(
            matches!(
                m.status(),
                PredictionStatus::Open | PredictionStatus::Frozen
            ) && m.proposal().is_none(),
            shared::PredictionProposalUnavailable
        );
    }
    Ok(())
}

/// Validates a bounded `ar://` or `https://` evidence URI and a nonzero digest.
/// # Errors
/// `InvalidPredictionEvidence` for an oversized, non-graphic, unsupported or
/// empty URI, or an all-zero hash.
pub fn validate_evidence(evidence_uri: &str, evidence_hash: &[u8; 32]) -> Result<()> {
    let target = evidence_uri
        .strip_prefix("ar://")
        .or_else(|| evidence_uri.strip_prefix("https://"));
    require!(
        evidence_uri.len() <= PREDICTION_URI_MAX_LENGTH
            && evidence_uri.bytes().all(|b| b.is_ascii_graphic())
            && target.is_some_and(|s| !s.is_empty())
            && *evidence_hash != [0; 32],
        shared::InvalidPredictionEvidence
    );
    Ok(())
}

/// Moves a market with a freshly stored proposal into the Proposed state.
/// # Errors
/// Timestamp overflow: an unrepresentable maturity is rejected before the
/// proposal is persisted, because the whole instruction rolls back.
pub fn mark_proposed<M: ResolutionMarket>(m: &mut M) -> Result<()> {
    maturity(m)?;
    m.set_status(PredictionStatus::Proposed);
    Ok(())
}

/// Advances a published clock without choosing an arbitrary outcome.
/// # Inputs
/// Market, action (0 freeze at cutoff, 1 activate fallback, 2 finalize mature
/// proposal, 3 finalize the precommitted Invalid timeout) and current Unix seconds.
/// # Errors
/// Already final, wrong phase/status, missing proposal/fallback, immature delay
/// or missing/early deadline.
/// # Returns
/// One monotonic lifecycle transition; no SPL transfer and no admin override.
pub fn advance<M: ResolutionMarket>(m: &mut M, action: u8, now: i64) -> Result<()> {
    require!(
        m.final_outcome().is_none(),
        shared::PredictionResolutionUnavailable
    );
    match action {
        0 => {
            require!(
                m.status() == PredictionStatus::Open && now >= m.close_ts(),
                shared::PredictionResolutionUnavailable
            );
            m.set_status(PredictionStatus::Frozen);
        }
        1 => {
            let f = m.fallback().ok_or(shared::PredictionFallbackUnavailable)?;
            require!(
                matches!(
                    m.status(),
                    PredictionStatus::Open | PredictionStatus::Frozen
                ) && m.proposal().is_none()
                    && m.resolution_phase() == PredictionResolutionPhase::Primary
                    && now >= f.available_ts
                    && f.deadline_ts.is_none_or(|end| now < end),
                shared::PredictionFallbackUnavailable
            );
            m.set_status(PredictionStatus::Frozen);
            m.set_resolution_phase(PredictionResolutionPhase::Fallback);
        }
        2 => {
            require!(
                m.status() == PredictionStatus::Proposed && now >= maturity(m)?,
                shared::PredictionProposalUnavailable
            );
            let (outcome, _) = m.proposal().ok_or(shared::PredictionProposalUnavailable)?;
            m.set_final_outcome(outcome);
            m.set_status(PredictionStatus::Resolved);
        }
        3 => {
            let end = m
                .fallback()
                .and_then(|f| f.deadline_ts)
                .ok_or(shared::PredictionFallbackUnavailable)?;
            require!(
                matches!(
                    m.status(),
                    PredictionStatus::Open | PredictionStatus::Frozen
                ) && m.proposal().is_none()
                    && now >= end,
                shared::PredictionFallbackUnavailable
            );
            m.set_resolution_phase(PredictionResolutionPhase::Fallback);
            m.set_final_outcome(M::INVALID);
            m.set_status(PredictionStatus::Resolved);
        }
        _ => return err!(shared::PredictionResolutionUnavailable),
    }
    Ok(())
}

impl ResolutionMarket for PredictionMarket {
    type Outcome = PredictionResolution;
    const INVALID: Self::Outcome = PredictionResolution::Invalid;

    fn close_ts(&self) -> i64 {
        self.close_ts
    }
    fn earliest_resolution_ts(&self) -> Option<i64> {
        self.earliest_resolution_ts
    }
    fn resolver(&self) -> Pubkey {
        self.resolver
    }
    fn fallback(&self) -> Option<&PredictionFallback> {
        self.fallback.as_ref()
    }
    fn resolution_delay_seconds(&self) -> u64 {
        self.resolution_delay_seconds
    }
    fn resolution_phase(&self) -> PredictionResolutionPhase {
        self.resolution_phase
    }
    fn set_resolution_phase(&mut self, phase: PredictionResolutionPhase) {
        self.resolution_phase = phase;
    }
    fn status(&self) -> PredictionStatus {
        self.status
    }
    fn set_status(&mut self, status: PredictionStatus) {
        self.status = status;
    }
    fn proposal(&self) -> Option<(Self::Outcome, i64)> {
        self.proposal.as_ref().map(|p| (p.outcome, p.proposed_at))
    }
    fn final_outcome(&self) -> Option<Self::Outcome> {
        self.final_outcome
    }
    fn set_final_outcome(&mut self, outcome: Self::Outcome) {
        self.final_outcome = Some(outcome);
    }
}

impl ResolutionMarket for MultiOutcomeMarket {
    type Outcome = MultiOutcomeResolution;
    const INVALID: Self::Outcome = MultiOutcomeResolution::Invalid;

    fn close_ts(&self) -> i64 {
        self.terms.close_ts
    }
    fn earliest_resolution_ts(&self) -> Option<i64> {
        self.terms.earliest_resolution_ts
    }
    fn resolver(&self) -> Pubkey {
        self.terms.resolver
    }
    fn fallback(&self) -> Option<&PredictionFallback> {
        self.terms.fallback.as_ref()
    }
    fn resolution_delay_seconds(&self) -> u64 {
        self.terms.resolution_delay_seconds
    }
    fn resolution_phase(&self) -> PredictionResolutionPhase {
        self.resolution_phase
    }
    fn set_resolution_phase(&mut self, phase: PredictionResolutionPhase) {
        self.resolution_phase = phase;
    }
    fn status(&self) -> PredictionStatus {
        self.status
    }
    fn set_status(&mut self, status: PredictionStatus) {
        self.status = status;
    }
    fn proposal(&self) -> Option<(Self::Outcome, i64)> {
        self.proposal.as_ref().map(|p| (p.outcome, p.proposed_at))
    }
    fn final_outcome(&self) -> Option<Self::Outcome> {
        self.final_outcome
    }
    fn set_final_outcome(&mut self, outcome: Self::Outcome) {
        self.final_outcome = Some(outcome);
    }
}
