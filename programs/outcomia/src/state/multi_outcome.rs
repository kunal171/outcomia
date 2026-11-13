//! Foundation for single-winner markets with a bounded outcome list.
//!
//! These are new wire types, not extensions of the deployed binary enums.
//! No instruction accepts them yet. Outcome IDs are immutable list indices;
//! their validity depends on the particular market's frozen outcome count.

use anchor_lang::prelude::*;

/// Bound future per-market arrays and validation work. Two outcomes remain
/// supported, but existing YES/NO accounts keep their original representation.
pub const MULTI_OUTCOME_MIN_COUNT: u8 = 2;
pub const MULTI_OUTCOME_MAX_COUNT: u8 = 8;

/// Zero-based identifier in a market's immutable outcome list.
///
/// Borsh stores one byte. Deserialization is structural and can produce an ID
/// outside a market's list, so handlers must also call `is_valid_for` before
/// indexing an array or accepting an instruction-supplied ID.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub struct OutcomeId(u8);

impl OutcomeId {
    /// Inputs: zero-based index and the market's immutable outcome count.
    /// Errors: represented by `None` for an unsupported count or absent index.
    /// Returns: an ID validated against this count, not against another market.
    pub const fn new(index: u8, outcome_count: u8) -> Option<Self> {
        let outcome = Self(index);
        if outcome.is_valid_for(outcome_count) {
            Some(outcome)
        } else {
            None
        }
    }

    /// Inputs: this ID and the count from the actual market account.
    /// Errors: none. Returns false for an unsupported count or out-of-range ID.
    /// A valid ID still needs the correct market/account binding at instruction level.
    pub const fn is_valid_for(self, outcome_count: u8) -> bool {
        outcome_count >= MULTI_OUTCOME_MIN_COUNT
            && outcome_count <= MULTI_OUTCOME_MAX_COUNT
            && self.0 < outcome_count
    }

    /// Inputs: this ID. Errors: none. Returns its raw zero-based index.
    /// Call `is_valid_for` before using the index with market-specific arrays.
    pub const fn index(self) -> u8 {
        self.0
    }

    /// Inputs: this ID. Errors: none. Returns a fixed one-byte PDA seed.
    /// Future PDA derivations must also include the market and a separate
    /// multi-outcome namespace; this byte alone is not a unique account address.
    pub const fn seed(self) -> [u8; 1] {
        [self.0]
    }
}

/// Exactly one winner, or an Invalid result with the precommitted refund rule.
/// Invalid is never an additional tradable outcome. Variant order is wire ABI.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MultiOutcomeResolution {
    Winner(OutcomeId),
    Invalid,
}

impl MultiOutcomeResolution {
    /// Inputs: a proposed/final result and the actual market's outcome count.
    /// Errors: none. Returns whether the result references a supported market
    /// and an existing outcome. Authorization and payout checks are separate.
    pub const fn is_valid_for(self, outcome_count: u8) -> bool {
        match self {
            Self::Winner(outcome) => outcome.is_valid_for(outcome_count),
            Self::Invalid => {
                outcome_count >= MULTI_OUTCOME_MIN_COUNT && outcome_count <= MULTI_OUTCOME_MAX_COUNT
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_accept_only_indices_in_supported_market_lists() {
        for count in 0..=u8::MAX {
            for index in 0..=u8::MAX {
                let expected = (2..=8).contains(&count) && index < count;
                assert_eq!(OutcomeId::new(index, count).is_some(), expected);
            }
        }
    }

    #[test]
    fn wire_tags_and_seed_bytes_are_stable() {
        let id = OutcomeId::new(7, 8).expect("supported outcome");
        let mut bytes = Vec::new();
        MultiOutcomeResolution::Winner(id)
            .serialize(&mut bytes)
            .expect("serialize winner");
        assert_eq!(bytes, [0, 7]);
        bytes.clear();
        MultiOutcomeResolution::Invalid
            .serialize(&mut bytes)
            .expect("serialize invalid");
        assert_eq!(bytes, [1]);
        assert_eq!(OutcomeId::INIT_SPACE, 1);
        assert_eq!(MultiOutcomeResolution::INIT_SPACE, 2);
        assert_eq!(id.seed(), [7]);
        assert_eq!(id.index(), 7);
    }

    #[test]
    fn deserialized_ids_and_results_require_market_specific_validation() {
        let id = OutcomeId::deserialize(&mut &[7_u8][..]).expect("valid wire byte");
        assert!(!id.is_valid_for(3));
        assert!(id.is_valid_for(8));
        assert!(!MultiOutcomeResolution::Winner(id).is_valid_for(3));
        assert!(MultiOutcomeResolution::Winner(id).is_valid_for(8));
        assert!(MultiOutcomeResolution::Invalid.is_valid_for(3));
        assert!(!MultiOutcomeResolution::Invalid.is_valid_for(0));
        assert!(!MultiOutcomeResolution::Invalid.is_valid_for(9));
    }
}
