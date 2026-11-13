//! Foundation for single-winner markets with a bounded outcome list.
//!
//! These are new wire types, not extensions of the deployed binary enums.
//! Creation and custody use the layouts below; outcome-specific trading and
//! resolution instructions are not implemented. IDs are immutable list indices;
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

/// Fixed array capacity follows the supported outcome-count bound.
pub const MULTI_OUTCOME_CAPACITY: usize = MULTI_OUTCOME_MAX_COUNT as usize;
/// Bytes, not Unicode character count; bounds rent and serialized input size.
pub const MULTI_OUTCOME_LABEL_MAX_BYTES: usize = 64;

/// Economic and resolution terms frozen at market creation. An initializer must
/// call `validate_multi_outcome_terms` and bind resolver to the active-admin
/// creator. Structural deserialization and InitSpace do not enforce these rules.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct MultiOutcomeTerms {
    pub resolver: Pubkey,
    pub fallback: Option<super::PredictionFallback>,
    /// Order determines permanent OutcomeIds; edits/reordering are forbidden.
    #[max_len(MULTI_OUTCOME_CAPACITY, MULTI_OUTCOME_LABEL_MAX_BYTES)]
    pub outcome_labels: Vec<String>,
    pub question_hash: [u8; 32],
    pub rules_hash: [u8; 32],
    #[max_len(super::PREDICTION_URI_MAX_LENGTH)]
    pub rules_uri: String,
    pub close_ts: i64,
    pub earliest_resolution_ts: Option<i64>,
    pub resolution_delay_seconds: u64,
    /// Raw SPL collateral atoms per winning whole contract, not a display price.
    pub payout_per_contract: u64,
    pub price_tick: u64,
    /// All splits, fills, merges and claims must preserve this lot. For N=3,
    /// P=1,000,000, L=3 permits exact Invalid refunds; L=1 does not.
    pub quantity_lot: u64,
}

/// Evidence for a pending result; correction replaces this entire record.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct MultiOutcomeProposal {
    pub outcome: MultiOutcomeResolution,
    pub proposed_at: i64,
    #[max_len(super::PREDICTION_URI_MAX_LENGTH)]
    pub evidence_uri: String,
    pub evidence_hash: [u8; 32],
}

/// New layout, never decoded as a deployed binary PredictionMarket.
/// PDA: ["multi_market", market_id]. Creation initializes a zero-backed Draft.
/// The reserve vault will back outcome liabilities; shared AssetBalance accounts
/// remain the only ledger for a trader's free or order-locked collateral.
#[account]
#[derive(InitSpace)]
pub struct MultiOutcomeMarket {
    pub market_id: [u8; 32],
    pub authority: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub metadata: Pubkey,
    pub terms: MultiOutcomeTerms,
    pub resolution_phase: super::PredictionResolutionPhase,
    pub status: super::PredictionStatus,
    pub proposal: Option<MultiOutcomeProposal>,
    pub final_outcome: Option<MultiOutcomeResolution>,
    /// Outstanding contracts, including ask escrow; unused slots stay zero.
    /// Before resolution all active supplies must equal the complete-set count.
    pub supplies: [u64; MULTI_OUTCOME_CAPACITY],
    pub backing_reserve: u64,
    pub open_order_count: u64,
    pub bump: u8,
}

/// New per-market owner position: ["multi_position", market, owner].
/// Quantities are whole contracts. Each active free/locked amount must follow
/// the market lot; unused outcome slots must stay zero. No collateral is stored
/// here, so another market can reuse the same shared per-asset wallet balance.
#[account]
#[derive(InitSpace)]
pub struct MultiOutcomePosition {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub free: [u64; MULTI_OUTCOME_CAPACITY],
    pub locked: [u64; MULTI_OUTCOME_CAPACITY],
    pub bump: u8,
}

/// Initial bounded index: price/FIFO selection scans at most 64 references.
/// This avoids changing the deployed binary linked-list books. Capacity is a
/// product limit; higher-volume indexing needs a separately versioned layout.
pub const MULTI_OUTCOME_MAX_ORDERS: usize = 64;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub struct MultiOutcomeOrderReference {
    pub order: Pubkey,
    pub order_id: u64,
    pub outcome: OutcomeId,
    pub side: super::OrderSide,
    pub price: u64,
}

/// PDA ["multi_book", market]. No close/reinitialize path resets acceptance IDs.
/// Cash fees are backed by global collateral custody, separately from outcomes.
#[account]
#[derive(InitSpace)]
pub struct MultiOutcomeBook {
    pub market: Pubkey,
    pub authority: Pubkey,
    #[max_len(MULTI_OUTCOME_MAX_ORDERS)]
    pub orders: Vec<MultiOutcomeOrderReference>,
    pub next_order_id: u64,
    pub accrued_collateral_fees: u64,
    pub bump: u8,
}

/// PDA ["multi_order", book, order_id_le]. Filled/canceled history is retained.
/// A bid locks exactly remaining_quantity*price cash atoms; an ask locks exactly
/// remaining_quantity outcome contracts. Resting orders are makers and pay no fee.
#[account]
#[derive(InitSpace)]
pub struct MultiOutcomeOrder {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub book: Pubkey,
    pub order_id: u64,
    pub outcome: OutcomeId,
    pub side: super::OrderSide,
    pub price: u64,
    pub quantity: u64,
    pub remaining_quantity: u64,
    pub locked_amount: u64,
    pub status: super::OrderStatus,
    pub bump: u8,
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
