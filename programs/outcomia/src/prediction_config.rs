//! Pure validation of prediction-market creation terms.
//!
//! This module does not read accounts, fetch Arweave data or mutate state.
//! The initializer passes Solana Clock time and separately validates
//! administrator authority, mint ownership and canonical vault/metadata PDAs.
//! It also binds the primary resolver to the creator; this pure helper has no
//! signer argument and cannot enforce that account relationship by itself.

use anchor_lang::prelude::*;

use crate::{
    errors::prediction,
    state::{PredictionFallback, PREDICTION_URI_MAX_LENGTH},
};

/// Creation terms that can be checked before allocating any market accounts.
///
/// Absence is deliberate: no earliest time uses close time; no fallback has
/// no resolver timeout; a fallback without a deadline has an open-ended window.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PredictionMarketConfig {
    pub resolver: Pubkey,
    pub fallback: Option<PredictionFallback>,
    pub close_ts: i64,
    pub earliest_resolution_ts: Option<i64>,
    pub resolution_delay_seconds: u64,
    pub payout_per_contract: u64,
    pub price_tick: u64,
    pub rules_uri: String,
    pub question_hash: [u8; 32],
    pub rules_hash: [u8; 32],
}

/// Checks the creation-time invariants without treating absent options as zero.
///
/// `now` must come from Clock in an instruction; accepting it as an argument
/// here permits deterministic boundary tests without RPC or token transfers.
///
/// # Inputs
/// Borrowed `config` and Unix-second `now`; instructions supply chain Clock, while tests may fix
/// it.
///
/// # Errors
/// Invalid close/resolution/fallback windows, resolver, delay, payout, tick, URI/hash commitments
/// or timestamp overflow.
///
/// # Returns
/// `Ok(())` without allocating or mutating accounts. Creator equality, mint decimals and admin
/// authority are checked by the initializer.
pub fn validate_prediction_market_config(config: &PredictionMarketConfig, now: i64) -> Result<()> {
    require!(
        config.close_ts > now,
        prediction::InvalidPredictionCloseTime
    );
    // None means "use close time", not timestamp zero. With close=200 and no
    // earliest override, a 10-second review delay may first finish at 210.
    let earliest = config.earliest_resolution_ts.unwrap_or(config.close_ts);
    require!(
        earliest >= config.close_ts,
        prediction::InvalidPredictionResolutionTime
    );
    require!(
        config.resolver != Pubkey::default(),
        prediction::InvalidPredictionResolver
    );

    // Delay is unsigned in storage, but Solana timestamps use i64. Reject
    // conversion overflow instead of wrapping a huge delay into the past.
    let delay = i64::try_from(config.resolution_delay_seconds)
        .map_err(|_| error!(prediction::InvalidPredictionResolutionDelay))?;
    require!(delay > 0, prediction::InvalidPredictionResolutionDelay);
    earliest
        .checked_add(delay)
        .ok_or(prediction::PredictionTimestampOverflow)?;

    // The optional group keeps resolver and activation time inseparable. A
    // missing deadline is an intentionally unbounded fallback window, not an
    // already expired one; this validator must preserve that distinction.
    if let Some(fallback) = &config.fallback {
        require!(
            fallback.resolver != Pubkey::default() && fallback.resolver != config.resolver,
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
            // Deadline is exclusive: a proposal at deadline - 1 may finalize
            // later than the deadline. Do not require delay to fit the window.
            let latest_proposal = deadline
                .checked_sub(1)
                .ok_or(prediction::PredictionTimestampOverflow)?;
            latest_proposal
                .checked_add(delay)
                .ok_or(prediction::PredictionTimestampOverflow)?;
        }
    }

    require!(
        config.payout_per_contract > 0 && config.payout_per_contract.is_multiple_of(2),
        prediction::InvalidPredictionPayout
    );
    // Divisibility keeps complementary prices on the same grid: if p is a
    // valid tick, payout - p is also valid. tick < payout leaves a trade price.
    require!(
        config.price_tick > 0
            && config.price_tick < config.payout_per_contract
            && config.payout_per_contract.is_multiple_of(config.price_tick),
        prediction::InvalidPredictionPriceTick
    );

    let uri = &config.rules_uri;
    // This is a bounded reference check, not a full URL parser or proof that
    // a document exists. Clients must verify content hashes and rule fields.
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
        config.question_hash != [0; 32] && config.rules_hash != [0; 32],
        prediction::InvalidPredictionRulesHash
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::OutcomiaError;

    const NOW: i64 = 100;

    fn config() -> PredictionMarketConfig {
        PredictionMarketConfig {
            resolver: Pubkey::new_unique(),
            fallback: Some(PredictionFallback {
                resolver: Pubkey::new_unique(),
                available_ts: 300,
                deadline_ts: Some(400),
            }),
            close_ts: 200,
            earliest_resolution_ts: Some(250),
            resolution_delay_seconds: 10,
            payout_per_contract: 1_000_000,
            price_tick: 10_000,
            rules_uri: format!("ar://{}", "a".repeat(43)),
            question_hash: [1; 32],
            rules_hash: [2; 32],
        }
    }

    fn rejects(config: &PredictionMarketConfig, expected: OutcomiaError) {
        // Compare the actual Anchor code, not only is_err(), so a different
        // earlier validation failure cannot accidentally make the test pass.
        let actual = validate_prediction_market_config(config, NOW).unwrap_err();
        let expected: anchor_lang::error::Error = expected.into();
        match (actual, expected) {
            (
                anchor_lang::error::Error::AnchorError(actual),
                anchor_lang::error::Error::AnchorError(expected),
            ) => {
                assert_eq!(actual.error_code_number, expected.error_code_number);
            }
            errors => panic!("unexpected error variants: {errors:?}"),
        }
    }

    #[test]
    fn accepts_optional_resolution_configurations() {
        let mut config = config();
        validate_prediction_market_config(&config, NOW).unwrap();
        config.earliest_resolution_ts = None;
        validate_prediction_market_config(&config, NOW).unwrap();
        config.fallback.as_mut().unwrap().deadline_ts = None;
        validate_prediction_market_config(&config, NOW).unwrap();
        config.fallback = None;
        validate_prediction_market_config(&config, NOW).unwrap();
    }

    #[test]
    fn close_must_be_strictly_in_the_future() {
        let mut config = config();
        for close in [NOW - 1, NOW] {
            config.close_ts = close;
            rejects(&config, prediction::InvalidPredictionCloseTime);
        }
        config.close_ts = NOW + 1;
        validate_prediction_market_config(&config, NOW).unwrap();
    }

    #[test]
    fn earliest_time_cannot_precede_close() {
        let mut config = config();
        config.earliest_resolution_ts = Some(config.close_ts - 1);
        rejects(&config, prediction::InvalidPredictionResolutionTime);
        config.earliest_resolution_ts = Some(config.close_ts);
        validate_prediction_market_config(&config, NOW).unwrap();
    }

    #[test]
    fn fallback_windows_are_ordered_with_and_without_optional_earliest_time() {
        let mut config = config();
        for earliest in [Some(250), None] {
            config.earliest_resolution_ts = earliest;
            let effective = earliest.unwrap_or(config.close_ts);
            for available in [effective - 1, effective] {
                config.fallback.as_mut().unwrap().available_ts = available;
                rejects(&config, prediction::InvalidPredictionFallback);
            }
            config.fallback.as_mut().unwrap().available_ts = effective + 1;
            validate_prediction_market_config(&config, NOW).unwrap();
        }
        config.fallback.as_mut().unwrap().available_ts = 300;
        for deadline in [299, 300] {
            config.fallback.as_mut().unwrap().deadline_ts = Some(deadline);
            rejects(&config, prediction::InvalidPredictionFallback);
        }
        // A one-second proposal window is valid even with a longer delay.
        config.fallback.as_mut().unwrap().deadline_ts = Some(301);
        validate_prediction_market_config(&config, NOW).unwrap();
    }

    #[test]
    fn rejects_missing_or_identical_resolver_keys() {
        let mut config = config();
        config.resolver = Pubkey::default();
        rejects(&config, prediction::InvalidPredictionResolver);
        config.resolver = Pubkey::new_unique();
        config.fallback.as_mut().unwrap().resolver = Pubkey::default();
        rejects(&config, prediction::InvalidPredictionResolver);
        config.fallback.as_mut().unwrap().resolver = config.resolver;
        rejects(&config, prediction::InvalidPredictionResolver);
    }

    #[test]
    fn delay_must_be_positive_and_representable() {
        let mut config = config();
        for delay in [0, i64::MAX as u64 + 1, u64::MAX] {
            config.resolution_delay_seconds = delay;
            rejects(&config, prediction::InvalidPredictionResolutionDelay);
        }
    }

    #[test]
    fn rejects_overflow_at_each_resolution_boundary() {
        let mut config = config();
        config.earliest_resolution_ts = Some(i64::MAX);
        rejects(&config, prediction::PredictionTimestampOverflow);
        config.earliest_resolution_ts = None;
        config.fallback.as_mut().unwrap().available_ts = i64::MAX;
        rejects(&config, prediction::PredictionTimestampOverflow);
        config.fallback.as_mut().unwrap().available_ts = 300;
        config.fallback.as_mut().unwrap().deadline_ts = Some(i64::MAX);
        rejects(&config, prediction::PredictionTimestampOverflow);
        config.resolution_delay_seconds = 1;
        validate_prediction_market_config(&config, NOW).unwrap();
    }

    #[test]
    fn payout_must_support_an_exact_half_and_tick_must_divide_it() {
        let mut config = config();
        for payout in [0, 1, 999_999, u64::MAX] {
            config.payout_per_contract = payout;
            rejects(&config, prediction::InvalidPredictionPayout);
        }
        config.payout_per_contract = 1_000_000;
        for tick in [0, 1_000_000, 1_000_001, 30_000] {
            config.price_tick = tick;
            rejects(&config, prediction::InvalidPredictionPriceTick);
        }
        config.payout_per_contract = 2;
        config.price_tick = 1;
        validate_prediction_market_config(&config, NOW).unwrap();
    }

    #[test]
    fn rules_uri_rejects_missing_target_whitespace_and_oversized_bytes() {
        let mut config = config();
        for uri in [
            "",
            "ar://",
            "https://",
            "ar:///",
            "https://?x",
            "ftp://rules",
            "ar://has space",
            "ar://has\nnewline",
            "ar://é",
        ] {
            config.rules_uri = uri.into();
            rejects(&config, prediction::InvalidPredictionRulesUri);
        }
        config.rules_uri = format!("https://arweave.net/{}", "a".repeat(43));
        validate_prediction_market_config(&config, NOW).unwrap();
        config.rules_uri = format!("ar://{}", "a".repeat(PREDICTION_URI_MAX_LENGTH - 5));
        validate_prediction_market_config(&config, NOW).unwrap();
        config.rules_uri.push('a');
        rejects(&config, prediction::InvalidPredictionRulesUri);
    }

    #[test]
    fn both_rules_commitments_must_be_present() {
        let mut config = config();
        config.question_hash = [0; 32];
        rejects(&config, prediction::InvalidPredictionRulesHash);
        config.question_hash = [1; 32];
        config.rules_hash = [0; 32];
        rejects(&config, prediction::InvalidPredictionRulesHash);
    }
}
