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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        MultiOutcomeProposal, MultiOutcomeTerms, OutcomeId, PredictionProposal,
        MULTI_OUTCOME_CAPACITY,
    };

    const CLOSE: i64 = 1_000;
    const EARLIEST: i64 = 1_100;
    const DELAY: u64 = 50;
    const AVAILABLE: i64 = 2_000;
    const DEADLINE: i64 = 3_000;

    fn primary() -> Pubkey {
        Pubkey::new_from_array([1; 32])
    }
    fn backup() -> Pubkey {
        Pubkey::new_from_array([2; 32])
    }
    fn fallback(deadline: Option<i64>) -> PredictionFallback {
        PredictionFallback {
            resolver: backup(),
            available_ts: AVAILABLE,
            deadline_ts: deadline,
        }
    }

    /// Test adapter: builds a fresh market and stores a proposal in it.
    trait Fixture: ResolutionMarket + Sized {
        fn build(fallback: Option<PredictionFallback>) -> Self;
        fn propose(&mut self, outcome: Self::Outcome, at: i64);
        fn sample() -> Self::Outcome;
    }

    impl Fixture for PredictionMarket {
        fn build(fallback: Option<PredictionFallback>) -> Self {
            PredictionMarket {
                market_id: [7; 32],
                authority: primary(),
                resolver: primary(),
                fallback,
                collateral_mint: Pubkey::default(),
                collateral_vault: Pubkey::default(),
                metadata: Pubkey::default(),
                question_hash: [1; 32],
                rules_hash: [1; 32],
                rules_uri: "ar://rules".into(),
                close_ts: CLOSE,
                earliest_resolution_ts: Some(EARLIEST),
                resolution_delay_seconds: DELAY,
                resolution_phase: PredictionResolutionPhase::Primary,
                status: PredictionStatus::Open,
                proposal: None,
                final_outcome: None,
                payout_per_contract: 1_000_000,
                price_tick: 10_000,
                yes_supply: 0,
                no_supply: 0,
                backing_reserve: 0,
                open_order_count: 0,
                bump: 255,
            }
        }
        fn propose(&mut self, outcome: Self::Outcome, at: i64) {
            self.proposal = Some(PredictionProposal {
                outcome,
                proposed_at: at,
                evidence_uri: "ar://evidence".into(),
                evidence_hash: [9; 32],
            });
            self.status = PredictionStatus::Proposed;
        }
        fn sample() -> Self::Outcome {
            PredictionResolution::No
        }
    }

    impl Fixture for MultiOutcomeMarket {
        fn build(fallback: Option<PredictionFallback>) -> Self {
            MultiOutcomeMarket {
                market_id: [7; 32],
                authority: primary(),
                collateral_mint: Pubkey::default(),
                collateral_vault: Pubkey::default(),
                metadata: Pubkey::default(),
                terms: MultiOutcomeTerms {
                    resolver: primary(),
                    fallback,
                    outcome_labels: vec!["A".into(), "B".into(), "C".into()],
                    question_hash: [1; 32],
                    rules_hash: [1; 32],
                    rules_uri: "ar://rules".into(),
                    close_ts: CLOSE,
                    earliest_resolution_ts: Some(EARLIEST),
                    resolution_delay_seconds: DELAY,
                    payout_per_contract: 1_000_000,
                    price_tick: 10_000,
                    quantity_lot: 3,
                },
                resolution_phase: PredictionResolutionPhase::Primary,
                status: PredictionStatus::Open,
                proposal: None,
                final_outcome: None,
                supplies: [0; MULTI_OUTCOME_CAPACITY],
                backing_reserve: 0,
                open_order_count: 0,
                bump: 255,
            }
        }
        fn propose(&mut self, outcome: Self::Outcome, at: i64) {
            self.proposal = Some(MultiOutcomeProposal {
                outcome,
                proposed_at: at,
                evidence_uri: "ar://evidence".into(),
                evidence_hash: [9; 32],
            });
            self.status = PredictionStatus::Proposed;
        }
        fn sample() -> Self::Outcome {
            MultiOutcomeResolution::Winner(OutcomeId::new(2, 3).unwrap())
        }
    }

    fn resolver_window_respects_schedule<M: Fixture>() {
        let no_fallback = M::build(None);
        assert!(resolver_window(&no_fallback, primary(), CLOSE).is_err()); // before earliest
        assert!(resolver_window(&no_fallback, primary(), EARLIEST).is_ok());
        assert!(resolver_window(&no_fallback, primary(), i64::MAX).is_ok()); // no end
        assert!(resolver_window(&no_fallback, backup(), EARLIEST).is_err());

        let mut m = M::build(Some(fallback(Some(DEADLINE))));
        assert!(resolver_window(&m, primary(), AVAILABLE - 1).is_ok());
        assert!(resolver_window(&m, primary(), AVAILABLE).is_err()); // primary ends
        m.set_resolution_phase(PredictionResolutionPhase::Fallback);
        assert!(resolver_window(&m, backup(), AVAILABLE - 1).is_err());
        assert!(resolver_window(&m, backup(), AVAILABLE).is_ok());
        assert!(resolver_window(&m, primary(), AVAILABLE).is_err());
        assert!(resolver_window(&m, backup(), DEADLINE).is_err()); // exclusive
    }

    fn proposal_state_allows_one_proposal_and_timely_corrections<M: Fixture>() {
        let mut m = M::build(None);
        assert!(check_proposal_state(&m, EARLIEST, false).is_ok());
        assert!(check_proposal_state(&m, EARLIEST, true).is_err()); // nothing to correct
        m.propose(M::sample(), EARLIEST);
        let mature = EARLIEST + DELAY as i64;
        assert_eq!(maturity(&m).unwrap(), mature);
        assert!(check_proposal_state(&m, EARLIEST, false).is_err()); // no second proposal
        assert!(check_proposal_state(&m, mature - 1, true).is_ok());
        assert!(check_proposal_state(&m, mature, true).is_err()); // matured
    }

    fn advance_follows_the_published_clock<M: Fixture>()
    where
        M::Outcome: PartialEq + core::fmt::Debug,
    {
        // 0: freeze only at the cutoff.
        let mut m = M::build(None);
        assert!(advance(&mut m, 0, CLOSE - 1).is_err());
        advance(&mut m, 0, CLOSE).unwrap();
        assert_eq!(m.status(), PredictionStatus::Frozen);

        // 2: finalize exactly the proposed outcome, only at maturity.
        m.propose(M::sample(), EARLIEST);
        let mature = EARLIEST + DELAY as i64;
        assert!(advance(&mut m, 2, mature - 1).is_err());
        advance(&mut m, 2, mature).unwrap();
        assert_eq!(m.final_outcome(), Some(M::sample()));
        assert_eq!(m.status(), PredictionStatus::Resolved);
        for action in 0..=3 {
            assert!(advance(&mut m, action, i64::MAX).is_err()); // final is final
        }

        // 1: activate fallback inside its window.
        let mut m = M::build(Some(fallback(Some(DEADLINE))));
        assert!(advance(&mut m, 1, AVAILABLE - 1).is_err());
        advance(&mut m, 1, AVAILABLE).unwrap();
        assert_eq!(m.resolution_phase(), PredictionResolutionPhase::Fallback);
        assert!(advance(&mut m, 1, AVAILABLE).is_err()); // once only

        // 3: Invalid after an unproposed deadline, never over a proposal.
        let mut m = M::build(Some(fallback(Some(DEADLINE))));
        assert!(advance(&mut m, 3, DEADLINE - 1).is_err());
        advance(&mut m, 3, DEADLINE).unwrap();
        assert_eq!(m.final_outcome(), Some(M::INVALID));
        let mut m = M::build(Some(fallback(Some(DEADLINE))));
        m.propose(M::sample(), EARLIEST);
        assert!(advance(&mut m, 3, DEADLINE).is_err());
        let mut m = M::build(Some(fallback(None)));
        assert!(advance(&mut m, 3, i64::MAX).is_err()); // no deadline, no timeout

        assert!(advance(&mut M::build(None), 4, i64::MAX).is_err());
    }

    #[test]
    fn binary_lifecycle() {
        resolver_window_respects_schedule::<PredictionMarket>();
        proposal_state_allows_one_proposal_and_timely_corrections::<PredictionMarket>();
        advance_follows_the_published_clock::<PredictionMarket>();
    }

    #[test]
    fn multi_outcome_lifecycle() {
        resolver_window_respects_schedule::<MultiOutcomeMarket>();
        proposal_state_allows_one_proposal_and_timely_corrections::<MultiOutcomeMarket>();
        advance_follows_the_published_clock::<MultiOutcomeMarket>();
    }

    #[test]
    fn evidence_must_be_bounded_supported_and_hashed() {
        let hash = [9; 32];
        assert!(validate_evidence("ar://tx", &hash).is_ok());
        assert!(validate_evidence("https://example.org/a", &hash).is_ok());
        assert!(validate_evidence("ar://", &hash).is_err());
        assert!(validate_evidence("http://example.org", &hash).is_err());
        assert!(validate_evidence("ar://a b", &hash).is_err());
        assert!(validate_evidence("ar://tx", &[0; 32]).is_err());
        let long = format!("ar://{}", "a".repeat(PREDICTION_URI_MAX_LENGTH));
        assert!(validate_evidence(&long, &hash).is_err());
    }
}
