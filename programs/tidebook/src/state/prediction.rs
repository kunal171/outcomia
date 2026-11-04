//! Binary prediction layouts, isolated from the existing spot ledger.
//!
//! These types define serialization and allocation only. Future instructions
//! must enforce authority, timing and conservation. Enum and field order are
//! persistent storage contracts; changing them later requires a migration.

use anchor_lang::prelude::*;

/// Maximum UTF-8 bytes reserved for each Arweave rules or evidence URI.
/// `max_len` computes space; future handlers must reject oversized inputs.
pub const PREDICTION_URI_MAX_LENGTH: usize = 200;

/// Tradable positions. Invalid is a resolution result, never a third asset.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum PredictionOutcome {
    Yes,
    No,
}

/// Payout schedule: YES wins, NO wins, or both receive half the payout.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum PredictionResolution {
    Yes,
    No,
    Invalid,
}

/// Stored lifecycle; trade handlers must also enforce the closing timestamp.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum PredictionStatus {
    Draft,
    Open,
    Frozen,
    Proposed,
    Resolved,
}

/// Selects the resolver authorized within its fixed proposal window.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum PredictionResolutionPhase {
    Primary,
    Fallback,
}

/// Optional fallback policy, fixed with the market's original rules.
///
/// Keeping the key and activation time together prevents partial configuration
/// such as a fallback deadline without a resolver. No deadline means the
/// fallback may propose indefinitely; no automatic timeout payout is possible.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct PredictionFallback {
    pub resolver: Pubkey,
    /// Unix seconds when primary proposals stop and fallback becomes eligible.
    pub available_ts: i64,
    /// Exclusive proposal/correction deadline, if a timeout was agreed upon.
    pub deadline_ts: Option<i64>,
}

/// Evidence and timing attached to an actual proposed outcome.
///
/// The market stores `None` before proposal instead of relying on zero hashes,
/// an empty URI or a sentinel timestamp. Future handlers must validate evidence
/// and replace the entire proposal when a correction restarts the delay.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace, Debug)]
pub struct PredictionProposal {
    pub outcome: PredictionResolution,
    pub proposed_at: i64,
    #[max_len(PREDICTION_URI_MAX_LENGTH)]
    pub evidence_uri: String,
    pub evidence_hash: [u8; 32],
}

/// Terms and aggregate liabilities for a single-collateral binary market.
///
/// PDA: ["prediction_market", market_id]. The creator supplies a 32-byte ID,
/// unique within this program. A separate account leaves spot layouts intact.
#[account]
#[derive(InitSpace)]
pub struct PredictionMarket {
    /// Retained for future PDA constraints and signer seed reconstruction.
    pub market_id: [u8; 32],
    pub authority: Pubkey,
    pub resolver: Pubkey,
    /// None selects primary-only resolution; there is no fallback timeout.
    pub fallback: Option<PredictionFallback>,
    /// Only SPL asset deposited into and withdrawn from this market.
    pub collateral_mint: Pubkey,
    pub collateral_vault: Pubkey,
    /// Short labels, separate from immutable economic terms.
    pub metadata: Pubkey,
    /// SHA-256 of the question's UTF-8 bytes, without normalization.
    pub question_hash: [u8; 32],
    /// SHA-256 of the exact uploaded Arweave rules document bytes.
    pub rules_hash: [u8; 32],
    #[max_len(PREDICTION_URI_MAX_LENGTH)]
    pub rules_uri: String,
    /// Unix seconds. Placement and matching must reject now >= close_ts.
    pub close_ts: i64,
    /// None uses close_ts as the earliest proposal time. It never permits
    /// resolution while trading is still open.
    pub earliest_resolution_ts: Option<i64>,
    /// The full delay restarts after every permitted correction.
    pub resolution_delay_seconds: u64,
    pub resolution_phase: PredictionResolutionPhase,
    pub status: PredictionStatus,
    /// Outcome, timestamp and evidence are either all present or all absent.
    pub proposal: Option<PredictionProposal>,
    /// Set only at finalization, including the precommitted timeout path.
    pub final_outcome: Option<PredictionResolution>,
    /// Raw collateral atoms per winning whole contract. Initialization must
    /// require an even value so Invalid pays an exact half to each outcome.
    pub payout_per_contract: u64,
    /// Raw collateral-price increment per whole contract.
    pub price_tick: u64,
    /// Outstanding whole contracts, including those locked in ask orders.
    pub yes_supply: u64,
    pub no_supply: u64,
    /// Collateral reserved for payouts, excluding trader cash and fees.
    /// Redemption reduces both outcome supply and this reserve.
    pub backing_reserve: u64,
    pub open_order_count: u64,
    pub bump: u8,
}

/// One trader's collateral claims and internal YES/NO positions.
///
/// PDA: ["prediction_position", market, owner]. Collateral is measured in SPL
/// mint atoms. YES/NO balances count whole contracts backed by the reserve;
/// they are not token accounts. Splitting and merging will move value between
/// free collateral and the market reserve without moving SPL tokens.
#[account]
#[derive(InitSpace)]
pub struct PredictionPosition {
    pub market: Pubkey,
    pub owner: Pubkey,
    /// Collateral available for withdrawal, bids or splitting.
    pub collateral_free: u64,
    /// Collateral reserved for open buy orders.
    pub collateral_locked: u64,
    /// Free outcomes may be sold, merged as a pair or redeemed when resolved.
    pub yes_free: u64,
    pub yes_locked: u64,
    pub no_free: u64,
    pub no_locked: u64,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialized<T: AnchorSerialize>(value: &T) -> Vec<u8> {
        let mut bytes = Vec::new();
        value.serialize(&mut bytes).expect("serialize test value");
        bytes
    }

    #[test]
    fn prediction_enum_tags_are_stable() {
        assert_eq!(serialized(&PredictionOutcome::Yes), [0]);
        assert_eq!(serialized(&PredictionOutcome::No), [1]);
        for (tag, outcome) in [
            PredictionResolution::Yes,
            PredictionResolution::No,
            PredictionResolution::Invalid,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(serialized(&outcome), [tag as u8]);
        }
        for (tag, status) in [
            PredictionStatus::Draft,
            PredictionStatus::Open,
            PredictionStatus::Frozen,
            PredictionStatus::Proposed,
            PredictionStatus::Resolved,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(serialized(&status), [tag as u8]);
        }
        assert_eq!(serialized(&PredictionResolutionPhase::Primary), [0]);
        assert_eq!(serialized(&PredictionResolutionPhase::Fallback), [1]);
        let missing: Option<PredictionResolution> = None;
        assert_eq!(serialized(&missing), [0]);
        assert_eq!(serialized(&Some(PredictionResolution::Invalid)), [1, 2]);
    }

    #[test]
    fn prediction_market_maximum_serialization_fits_allocated_space() {
        let market = PredictionMarket {
            market_id: [7; 32],
            authority: Pubkey::new_unique(),
            resolver: Pubkey::new_unique(),
            fallback: Some(PredictionFallback {
                resolver: Pubkey::new_unique(),
                available_ts: 300,
                deadline_ts: Some(400),
            }),
            collateral_mint: Pubkey::new_unique(),
            collateral_vault: Pubkey::new_unique(),
            metadata: Pubkey::new_unique(),
            question_hash: [1; 32],
            rules_hash: [2; 32],
            rules_uri: "r".repeat(PREDICTION_URI_MAX_LENGTH),
            close_ts: 100,
            earliest_resolution_ts: Some(200),
            resolution_delay_seconds: 10,
            resolution_phase: PredictionResolutionPhase::Primary,
            status: PredictionStatus::Resolved,
            proposal: Some(PredictionProposal {
                outcome: PredictionResolution::Yes,
                proposed_at: 210,
                evidence_uri: "e".repeat(PREDICTION_URI_MAX_LENGTH),
                evidence_hash: [3; 32],
            }),
            final_outcome: Some(PredictionResolution::Yes),
            payout_per_contract: 1_000_000,
            price_tick: 10_000,
            yes_supply: 10,
            no_supply: 10,
            backing_reserve: 10_000_000,
            open_order_count: 0,
            bump: 255,
        };
        // Maximum Borsh payload: keys, hashes, bounded strings, timestamps,
        // enum tags, Option tags/payloads and accounting. No Rust padding.
        assert_eq!(PredictionMarket::INIT_SPACE, 834);
        let mut bytes = Vec::new();
        market.try_serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), 8 + PredictionMarket::INIT_SPACE);
        let decoded = PredictionMarket::try_deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(decoded.rules_uri, market.rules_uri);
        assert_eq!(decoded.fallback, market.fallback);
        assert_eq!(
            decoded.earliest_resolution_ts,
            market.earliest_resolution_ts
        );
        assert_eq!(decoded.proposal, market.proposal);
        assert_eq!(decoded.final_outcome, market.final_outcome);
        assert_eq!(decoded.bump, market.bump);

        // Absent config and proposal must deserialize without sentinel values.
        let mut unproposed = market;
        unproposed.fallback = None;
        unproposed.earliest_resolution_ts = None;
        unproposed.proposal = None;
        unproposed.final_outcome = None;
        unproposed.status = PredictionStatus::Draft;
        let mut bytes = Vec::new();
        unproposed.try_serialize(&mut bytes).unwrap();
        assert!(bytes.len() < 8 + PredictionMarket::INIT_SPACE);
        // Allocated accounts retain maximum capacity when Options are None.
        bytes.resize(8 + PredictionMarket::INIT_SPACE, 0);
        let decoded = PredictionMarket::try_deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(decoded.fallback, None);
        assert_eq!(decoded.earliest_resolution_ts, None);
        assert_eq!(decoded.proposal, None);
        assert_eq!(decoded.final_outcome, None);
        assert_eq!(decoded.status, PredictionStatus::Draft);
    }

    #[test]
    fn fallback_without_deadline_is_distinct_from_no_fallback() {
        let fallback = PredictionFallback {
            resolver: Pubkey::new_unique(),
            available_ts: 300,
            deadline_ts: None,
        };
        assert_eq!(PredictionFallback::INIT_SPACE, 32 + 8 + 1 + 8);
        assert_eq!(PredictionProposal::INIT_SPACE, 1 + 8 + 4 + 200 + 32);
        let bytes = serialized(&Some(fallback.clone()));
        let decoded = Option::<PredictionFallback>::deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(decoded, Some(fallback));
        assert_ne!(bytes, serialized(&Option::<PredictionFallback>::None));
    }

    #[test]
    fn prediction_position_preserves_each_asset_and_balance_bucket() {
        let position = PredictionPosition {
            market: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            collateral_free: 11,
            collateral_locked: 22,
            yes_free: 33,
            yes_locked: 44,
            no_free: 55,
            no_locked: 66,
            bump: 254,
        };
        // Two public keys + six u64 balances + bump; excludes discriminator.
        assert_eq!(PredictionPosition::INIT_SPACE, 113);
        let mut bytes = Vec::new();
        position.try_serialize(&mut bytes).unwrap();
        assert_eq!(bytes.len(), 8 + PredictionPosition::INIT_SPACE);
        let decoded = PredictionPosition::try_deserialize(&mut bytes.as_slice()).unwrap();
        assert_eq!(decoded.market, position.market);
        assert_eq!(decoded.owner, position.owner);
        assert_eq!(decoded.collateral_free, 11);
        assert_eq!(decoded.collateral_locked, 22);
        assert_eq!(decoded.yes_free, 33);
        assert_eq!(decoded.yes_locked, 44);
        assert_eq!(decoded.no_free, 55);
        assert_eq!(decoded.no_locked, 66);
        assert_eq!(decoded.bump, 254);
    }
}
