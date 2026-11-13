//! Pure multi-outcome creation validation and exact collateral arithmetic.
//!
//! No accounts are mutated and no SPL transfers occur here. Future handlers must
//! bind real accounts/signers, use Clock, check owned quantities and compare the
//! computed liability with both recorded and physical reserve backing.
use anchor_lang::prelude::*;

use crate::{
    errors::{multi_outcome as multi, prediction},
    state::{
        MultiOutcomeResolution, MultiOutcomeTerms, MULTI_OUTCOME_CAPACITY,
        MULTI_OUTCOME_LABEL_MAX_BYTES, MULTI_OUTCOME_MAX_COUNT, MULTI_OUTCOME_MIN_COUNT,
        PREDICTION_URI_MAX_LENGTH,
    },
};

/// Read-only arithmetic view; not another serialized copy of immutable terms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MultiOutcomeEconomics {
    pub outcome_count: u8,
    pub payout_per_contract: u64,
    pub price_tick: u64,
    pub quantity_lot: u64,
}

impl MultiOutcomeEconomics {
    /// Inputs: terms from the canonical market, not caller-supplied economics.
    /// Errors: unsupported count or invalid numeric terms. Returns: validated
    /// arithmetic view without rechecking creation deadlines on an exit path.
    pub fn from_terms(terms: &MultiOutcomeTerms) -> Result<Self> {
        let outcome_count = u8::try_from(terms.outcome_labels.len())
            .map_err(|_| error!(multi::InvalidMultiOutcomeCount))?;
        let economics = Self {
            outcome_count,
            payout_per_contract: terms.payout_per_contract,
            price_tick: terms.price_tick,
            quantity_lot: terms.quantity_lot,
        };
        economics.validate()?;
        Ok(economics)
    }

    /// Inputs: proposed count, face payout, tick and lot in exact integer units.
    /// Errors: unsupported count, zero terms, unusable tick, inexact Invalid
    /// refunds or a single complete-set lot exceeding u64 collateral capacity.
    /// Returns: no mutation. Every public arithmetic helper revalidates this
    /// view so constructing it directly cannot bypass the precision rule.
    pub fn validate(self) -> Result<()> {
        require!(
            (MULTI_OUTCOME_MIN_COUNT..=MULTI_OUTCOME_MAX_COUNT).contains(&self.outcome_count),
            multi::InvalidMultiOutcomeCount
        );
        require!(
            self.payout_per_contract > 0,
            multi::InvalidMultiOutcomePayout
        );
        require!(
            self.price_tick > 0
                && self.price_tick < self.payout_per_contract
                && self.payout_per_contract.is_multiple_of(self.price_tick),
            multi::InvalidMultiOutcomePrice
        );
        require!(self.quantity_lot > 0, multi::InvalidMultiOutcomeLot);
        let lot_atoms = u128::from(self.quantity_lot) * u128::from(self.payout_per_contract);
        // A valid market must be able to fund at least one complete-set lot.
        // Widen first so invalid large terms cannot wrap into a small amount.
        checked_atoms(lot_atoms)?;
        require!(
            lot_atoms.is_multiple_of(u128::from(self.outcome_count)),
            multi::InvalidMultiOutcomeLot
        );
        Ok(())
    }
}

/// Inputs: immutable proposed terms and chain Clock's Unix-second `now`.
/// Errors: labels/count, economics, resolver/timing, URI/hash or timestamp overflow.
/// Returns: validated arithmetic view. This does not prove admin/creator identity,
/// canonical PDAs, mint ownership, document availability or token custody.
pub fn validate_multi_outcome_terms(
    terms: &MultiOutcomeTerms,
    now: i64,
) -> Result<MultiOutcomeEconomics> {
    let economics = MultiOutcomeEconomics::from_terms(terms)?;
    for (index, label) in terms.outcome_labels.iter().enumerate() {
        require!(
            !label.is_empty()
                && label.trim() == label
                && label.len() <= MULTI_OUTCOME_LABEL_MAX_BYTES
                && !label.chars().any(char::is_control)
                && !terms.outcome_labels[..index].contains(label),
            multi::InvalidMultiOutcomeLabel
        );
    }
    require!(terms.close_ts > now, prediction::InvalidPredictionCloseTime);
    let earliest = terms.earliest_resolution_ts.unwrap_or(terms.close_ts);
    require!(
        earliest >= terms.close_ts,
        prediction::InvalidPredictionResolutionTime
    );
    require!(
        terms.resolver != Pubkey::default(),
        prediction::InvalidPredictionResolver
    );
    let delay = i64::try_from(terms.resolution_delay_seconds)
        .map_err(|_| error!(prediction::InvalidPredictionResolutionDelay))?;
    require!(delay > 0, prediction::InvalidPredictionResolutionDelay);
    earliest
        .checked_add(delay)
        .ok_or(prediction::PredictionTimestampOverflow)?;
    if let Some(fallback) = &terms.fallback {
        require!(
            fallback.resolver != Pubkey::default() && fallback.resolver != terms.resolver,
            prediction::InvalidPredictionResolver
        );
        require!(
            fallback.available_ts > earliest,
            prediction::InvalidPredictionFallback
        );
        fallback
            .available_ts
            .checked_add(delay)
            .ok_or(prediction::PredictionTimestampOverflow)?;
        if let Some(deadline) = fallback.deadline_ts {
            require!(
                deadline > fallback.available_ts,
                prediction::InvalidPredictionFallback
            );
            deadline
                .checked_sub(1)
                .and_then(|last| last.checked_add(delay))
                .ok_or(prediction::PredictionTimestampOverflow)?;
        }
    }
    let uri = &terms.rules_uri;
    let target = uri
        .strip_prefix("ar://")
        .or_else(|| uri.strip_prefix("https://"));
    require!(
        uri.len() <= PREDICTION_URI_MAX_LENGTH
            && uri.bytes().all(|byte| byte.is_ascii_graphic())
            && target.is_some_and(|value| !value.is_empty() && !value.starts_with(['/', '?', '#'])),
        prediction::InvalidPredictionRulesUri
    );
    require!(
        terms.question_hash != [0; 32] && terms.rules_hash != [0; 32],
        prediction::InvalidPredictionRulesHash
    );
    Ok(economics)
}

/// Inputs: economics and a positive whole-lot number of complete sets.
/// Errors: invalid terms, zero/off-lot quantity or collateral overflow.
/// Returns: exact atoms to move between shared custody and the market reserve.
/// Example: three sets with face payout 1,000,000 require 3,000,000 atoms.
pub fn complete_set_collateral(economics: MultiOutcomeEconomics, quantity: u64) -> Result<u64> {
    economics.validate()?;
    require!(
        quantity > 0 && quantity.is_multiple_of(economics.quantity_lot),
        multi::InvalidMultiOutcomeLot
    );
    checked_atoms(u128::from(quantity) * u128::from(economics.payout_per_contract))
}

/// Inputs: economics, an existing final result and selected whole-contract amounts.
/// Errors: invalid outcome/terms, off-lot quantities, nonzero inactive slots or overflow.
/// Returns: exact payout without mutation or rounding. Losing quantities pay zero.
/// Zero selections return zero; a future instruction must reject all-zero no-ops
/// and verify ownership/supply before burning anything. Locked contracts must be
/// canceled first. For three outcomes, three Invalid contracts at face 1,000,000
/// pay 1,000,000 atoms; division is safe only after the lot rule has been checked.
pub fn redemption_payout(
    economics: MultiOutcomeEconomics,
    resolution: MultiOutcomeResolution,
    quantities: &[u64; MULTI_OUTCOME_CAPACITY],
) -> Result<u64> {
    economics.validate()?;
    validate_quantities(economics, quantities)?;
    require!(
        resolution.is_valid_for(economics.outcome_count),
        multi::InvalidMultiOutcomeId
    );
    let face = u128::from(economics.payout_per_contract);
    let amount = match resolution {
        MultiOutcomeResolution::Winner(outcome) => {
            u128::from(quantities[usize::from(outcome.index())]) * face
        }
        MultiOutcomeResolution::Invalid => {
            // Divide each widened amount before accumulating. A whole-lot input
            // is exactly divisible, so neither caller order nor claim batching
            // changes its payout. Never multiply u64 values before widening.
            quantities[..usize::from(economics.outcome_count)]
                .iter()
                .try_fold(0_u128, |sum, quantity| {
                    let payout = u128::from(*quantity) * face / u128::from(economics.outcome_count);
                    sum.checked_add(payout)
                        .ok_or(multi::MultiOutcomeAccountingOverflow)
                })?
        }
    };
    checked_atoms(amount)
}

/// Inputs: total outstanding supplies (including sell escrow) and optional final result.
/// Errors: malformed vectors, unequal unresolved supplies or excessive liability.
/// Returns: collateral atoms that must remain reserved. Before resolution, only
/// complete sets can change supply, so all active entries must agree. Afterwards
/// outcomes can be burned independently; winner/Invalid payouts determine backing.
/// This is an accounting check, not evidence that a vault contains these tokens.
pub fn reserve_liability(
    economics: MultiOutcomeEconomics,
    supplies: &[u64; MULTI_OUTCOME_CAPACITY],
    resolution: Option<MultiOutcomeResolution>,
) -> Result<u64> {
    economics.validate()?;
    validate_quantities(economics, supplies)?;
    if let Some(final_outcome) = resolution {
        return redemption_payout(economics, final_outcome, supplies);
    }
    require!(
        supplies[..usize::from(economics.outcome_count)]
            .iter()
            .all(|quantity| *quantity == supplies[0]),
        multi::MultiOutcomeSupplyMismatch
    );
    checked_atoms(u128::from(supplies[0]) * u128::from(economics.payout_per_contract))
}

/// Inputs: validated economics and a fixed quantity vector. Errors: inexact lots
/// or inactive nonzero slots. Returns: structural/economic vector validity only.
pub(crate) fn validate_quantities(
    economics: MultiOutcomeEconomics,
    quantities: &[u64; MULTI_OUTCOME_CAPACITY],
) -> Result<()> {
    for (index, quantity) in quantities.iter().enumerate() {
        if index >= usize::from(economics.outcome_count) {
            require!(*quantity == 0, multi::MultiOutcomeInactiveSlot);
        } else {
            require!(
                quantity.is_multiple_of(economics.quantity_lot),
                multi::InvalidMultiOutcomeLot
            );
        }
    }
    Ok(())
}

/// Inputs: widened atom calculation. Errors: value exceeds u64. Returns: SPL-sized atoms.
fn checked_atoms(amount: u128) -> Result<u64> {
    u64::try_from(amount).map_err(|_| error!(multi::MultiOutcomeAccountingOverflow))
}

#[cfg(test)]
mod tests;
