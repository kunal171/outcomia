//! Arithmetic and wire-layout checks; these do not simulate custody or instructions.
use super::*;
use crate::{errors::OutcomiaError, state::*};

fn economics(count: u8) -> MultiOutcomeEconomics {
    MultiOutcomeEconomics {
        outcome_count: count,
        payout_per_contract: 1_000_000,
        price_tick: 10_000,
        quantity_lot: u64::from(count),
    }
}
fn terms() -> MultiOutcomeTerms {
    MultiOutcomeTerms {
        resolver: Pubkey::new_unique(),
        fallback: None,
        outcome_labels: vec!["A".into(), "B".into(), "C".into()],
        question_hash: [1; 32],
        rules_hash: [2; 32],
        rules_uri: "ar://rules".into(),
        close_ts: 200,
        earliest_resolution_ts: None,
        resolution_delay_seconds: 10,
        payout_per_contract: 1_000_000,
        price_tick: 10_000,
        quantity_lot: 3,
    }
}
fn assert_error<T>(result: Result<T>, expected: OutcomiaError) {
    match result.err().expect("expected failure") {
        anchor_lang::error::Error::AnchorError(error) => {
            assert_eq!(error.error_code_number, u32::from(expected))
        }
        other => panic!("unexpected error: {other}"),
    }
}
fn vector(count: u8, quantity: u64) -> [u64; MULTI_OUTCOME_CAPACITY] {
    let mut result = [0; MULTI_OUTCOME_CAPACITY];
    result[..usize::from(count)].fill(quantity);
    result
}

#[test]
fn terms_validate_optional_windows_and_preserve_exact_labels() {
    let mut t = terms();
    assert_eq!(
        validate_multi_outcome_terms(&t, 100).expect("terms"),
        economics(3)
    );
    t.fallback = Some(PredictionFallback {
        resolver: Pubkey::new_unique(),
        available_ts: 300,
        deadline_ts: None,
    });
    validate_multi_outcome_terms(&t, 100).expect("unbounded fallback");
    t.fallback.as_mut().expect("fallback").deadline_ts = Some(301);
    // The latest permitted proposal may finalize after this exclusive deadline.
    validate_multi_outcome_terms(&t, 100).expect("short proposal window");
    t.outcome_labels = vec!["候補甲".into(), "候補乙".into(), "候補丙".into()];
    validate_multi_outcome_terms(&t, 100).expect("UTF-8 labels");
}

#[test]
fn labels_are_bounded_in_bytes_and_must_be_distinct_and_trimmed() {
    for labels in [
        vec!["A", "A", "C"],
        vec!["A", " B", "C"],
        vec!["A", "", "C"],
        vec!["A", "B\n", "C"],
    ] {
        let mut t = terms();
        t.outcome_labels = labels.into_iter().map(str::to_owned).collect();
        assert_error(
            validate_multi_outcome_terms(&t, 100),
            OutcomiaError::InvalidMultiOutcomeLabel,
        );
    }
    let mut t = terms();
    t.outcome_labels[0] = "界".repeat(22); // 66 bytes, only 22 characters.
    assert_error(
        validate_multi_outcome_terms(&t, 100),
        OutcomiaError::InvalidMultiOutcomeLabel,
    );
    t.outcome_labels = vec!["A".into(); 9];
    assert_error(
        validate_multi_outcome_terms(&t, 100),
        OutcomiaError::InvalidMultiOutcomeCount,
    );
    t.outcome_labels = vec!["A".into(); 256];
    assert_error(
        validate_multi_outcome_terms(&t, 100),
        OutcomiaError::InvalidMultiOutcomeCount,
    );
}

#[test]
fn creation_rejects_invalid_times_resolvers_and_document_commitments() {
    let mut cases = Vec::new();
    let mut t = terms();
    t.close_ts = 100;
    cases.push((t, OutcomiaError::InvalidPredictionCloseTime));
    let mut t = terms();
    t.earliest_resolution_ts = Some(199);
    cases.push((t, OutcomiaError::InvalidPredictionResolutionTime));
    let mut t = terms();
    t.resolver = Pubkey::default();
    cases.push((t, OutcomiaError::InvalidPredictionResolver));
    let mut t = terms();
    t.resolution_delay_seconds = 0;
    cases.push((t, OutcomiaError::InvalidPredictionResolutionDelay));
    let mut t = terms();
    t.resolution_delay_seconds = u64::MAX;
    cases.push((t, OutcomiaError::InvalidPredictionResolutionDelay));
    let mut t = terms();
    t.close_ts = i64::MAX;
    cases.push((t, OutcomiaError::PredictionTimestampOverflow));
    let mut t = terms();
    t.rules_uri = "ar://".into();
    cases.push((t, OutcomiaError::InvalidPredictionRulesUri));
    let mut t = terms();
    t.rules_hash = [0; 32];
    cases.push((t, OutcomiaError::InvalidPredictionRulesHash));
    let mut t = terms();
    t.fallback = Some(PredictionFallback {
        resolver: t.resolver,
        available_ts: 300,
        deadline_ts: None,
    });
    cases.push((t, OutcomiaError::InvalidPredictionResolver));
    let mut t = terms();
    t.fallback = Some(PredictionFallback {
        resolver: Pubkey::new_unique(),
        available_ts: 200,
        deadline_ts: None,
    });
    cases.push((t, OutcomiaError::InvalidPredictionFallback));
    let mut t = terms();
    t.fallback = Some(PredictionFallback {
        resolver: Pubkey::new_unique(),
        available_ts: 300,
        deadline_ts: Some(300),
    });
    cases.push((t, OutcomiaError::InvalidPredictionFallback));
    let mut t = terms();
    t.fallback = Some(PredictionFallback {
        resolver: Pubkey::new_unique(),
        available_ts: 300,
        deadline_ts: Some(i64::MAX),
    });
    cases.push((t, OutcomiaError::PredictionTimestampOverflow));
    for (t, error) in cases {
        assert_error(validate_multi_outcome_terms(&t, 100), error);
    }
}

#[test]
fn invalid_terms_and_unrepresentable_refunds_fail_before_arithmetic() {
    for count in [0, 1, 9, u8::MAX] {
        let mut e = economics(3);
        e.outcome_count = count;
        assert_error(e.validate(), OutcomiaError::InvalidMultiOutcomeCount);
    }
    let mut e = economics(3);
    e.payout_per_contract = 0;
    assert_error(e.validate(), OutcomiaError::InvalidMultiOutcomePayout);
    for tick in [0, 3, 1_000_000, 1_000_001] {
        let mut e = economics(3);
        e.price_tick = tick;
        assert_error(e.validate(), OutcomiaError::InvalidMultiOutcomePrice);
    }
    for lot in [0, 1, 2] {
        let mut e = economics(3);
        e.quantity_lot = lot;
        assert_error(e.validate(), OutcomiaError::InvalidMultiOutcomeLot);
    }
    let mut e = economics(3);
    e.quantity_lot = u64::MAX;
    assert_error(e.validate(), OutcomiaError::MultiOutcomeAccountingOverflow);
    let mut e = economics(4);
    e.quantity_lot = 1;
    e.validate().expect("exact quarter-token refunds");
}

#[test]
fn split_merge_and_invalid_redemption_conserve_full_sets_for_every_count() {
    // Independent conservation grid: every complete set must redeem to its face
    // value under every possible winner and under Invalid, however claims batch.
    for count in 2..=8 {
        let e = economics(count);
        for lots in 1..=32 {
            let q = u64::from(count) * lots;
            let reserve = complete_set_collateral(e, q).expect("sets");
            let supplies = vector(count, q);
            assert_eq!(
                reserve_liability(e, &supplies, None).expect("backing"),
                reserve
            );
            assert_eq!(
                redemption_payout(e, MultiOutcomeResolution::Invalid, &supplies).expect("invalid"),
                reserve
            );
            let mut separately = 0;
            for index in 0..count {
                let mut holding = [0; MULTI_OUTCOME_CAPACITY];
                holding[usize::from(index)] = q;
                separately += redemption_payout(e, MultiOutcomeResolution::Invalid, &holding)
                    .expect("individual claim");
                let winner =
                    MultiOutcomeResolution::Winner(OutcomeId::new(index, count).expect("outcome"));
                assert_eq!(
                    redemption_payout(e, winner, &supplies).expect("winner"),
                    reserve
                );
                assert_eq!(
                    reserve_liability(e, &supplies, Some(winner)).expect("winner backing"),
                    reserve
                );
            }
            assert_eq!(separately, reserve);
        }
    }
}

#[test]
fn sequential_claims_reduce_liability_by_exact_payout_and_clear_losers_for_zero() {
    let e = economics(3);
    let initial = vector(3, 9);
    for resolution in [
        MultiOutcomeResolution::Invalid,
        MultiOutcomeResolution::Winner(OutcomeId::new(1, 3).expect("winner")),
    ] {
        let mut supply = initial;
        let mut before = reserve_liability(e, &supply, Some(resolution)).expect("reserve");
        for index in [2, 0, 1] {
            for _ in 0..3 {
                let mut claim = [0; MULTI_OUTCOME_CAPACITY];
                claim[index] = 3;
                let payout = redemption_payout(e, resolution, &claim).expect("claim");
                supply[index] -= 3;
                let after = reserve_liability(e, &supply, Some(resolution)).expect("remaining");
                assert_eq!(before - after, payout);
                before = after;
            }
        }
        assert_eq!(before, 0);
        assert_eq!(supply, [0; MULTI_OUTCOME_CAPACITY]);
    }
}

#[test]
fn widened_arithmetic_divides_before_narrowing_and_rejects_excessive_outputs() {
    let e = MultiOutcomeEconomics {
        outcome_count: 2,
        payout_per_contract: 2,
        price_tick: 1,
        quantity_lot: 1,
    };
    let q = [u64::MAX, 0, 0, 0, 0, 0, 0, 0];
    assert_eq!(
        redemption_payout(e, MultiOutcomeResolution::Invalid, &q).expect("wide intermediate"),
        u64::MAX
    );
    assert_error(
        complete_set_collateral(e, u64::MAX),
        OutcomiaError::MultiOutcomeAccountingOverflow,
    );
    assert_error(
        redemption_payout(
            e,
            MultiOutcomeResolution::Winner(OutcomeId::new(0, 2).expect("winner")),
            &q,
        ),
        OutcomiaError::MultiOutcomeAccountingOverflow,
    );
    assert_error(
        redemption_payout(e, MultiOutcomeResolution::Invalid, &vector(2, u64::MAX)),
        OutcomiaError::MultiOutcomeAccountingOverflow,
    );
}

#[test]
fn quantities_unused_slots_and_unresolved_supply_mismatches_are_rejected() {
    let e = economics(3);
    for q in [0, 1, 2, 4] {
        assert_error(
            complete_set_collateral(e, q),
            OutcomiaError::InvalidMultiOutcomeLot,
        );
    }
    let mut q = vector(3, 3);
    q[2] = 1;
    assert_error(
        reserve_liability(e, &q, None),
        OutcomiaError::InvalidMultiOutcomeLot,
    );
    q = vector(3, 3);
    q[7] = 3;
    assert_error(
        reserve_liability(e, &q, None),
        OutcomiaError::MultiOutcomeInactiveSlot,
    );
    q = vector(3, 3);
    q[1] = 6;
    assert_error(
        reserve_liability(e, &q, None),
        OutcomiaError::MultiOutcomeSupplyMismatch,
    );
    assert_eq!(
        reserve_liability(e, &[0; 8], None).expect("empty reserve"),
        0
    );
    let forged = OutcomeId::deserialize(&mut &[7_u8][..]).expect("wire ID");
    assert_error(
        redemption_payout(e, MultiOutcomeResolution::Winner(forged), &vector(3, 3)),
        OutcomiaError::InvalidMultiOutcomeId,
    );
}

#[test]
fn maximum_account_serializations_match_space_without_changing_binary_discriminators() {
    let mut t = terms();
    t.outcome_labels = (0..8).map(|i| format!("{i}{}", "x".repeat(63))).collect();
    t.rules_uri = format!("https://{}", "x".repeat(192));
    t.earliest_resolution_ts = Some(220);
    t.fallback = Some(PredictionFallback {
        resolver: Pubkey::new_unique(),
        available_ts: 300,
        deadline_ts: Some(400),
    });
    t.quantity_lot = 1;
    validate_multi_outcome_terms(&t, 100).expect("max strings, supported count");
    assert_eq!(MultiOutcomeTerms::INIT_SPACE, 947);
    assert_eq!(MultiOutcomeProposal::INIT_SPACE, 246);
    let result = MultiOutcomeResolution::Winner(OutcomeId::new(7, 8).expect("winner"));
    let market = MultiOutcomeMarket {
        market_id: [1; 32],
        authority: Pubkey::new_unique(),
        collateral_mint: Pubkey::new_unique(),
        collateral_vault: Pubkey::new_unique(),
        metadata: Pubkey::new_unique(),
        terms: t,
        resolution_phase: PredictionResolutionPhase::Fallback,
        status: PredictionStatus::Resolved,
        proposal: Some(MultiOutcomeProposal {
            outcome: result,
            proposed_at: 300,
            evidence_uri: "x".repeat(200),
            evidence_hash: [3; 32],
        }),
        final_outcome: Some(result),
        supplies: [u64::MAX; 8],
        backing_reserve: u64::MAX,
        open_order_count: u64::MAX,
        bump: 255,
    };
    let mut bytes = Vec::new();
    market.serialize(&mut bytes).expect("market");
    assert_eq!(MultiOutcomeMarket::INIT_SPACE, 1440);
    assert_eq!(bytes.len(), MultiOutcomeMarket::INIT_SPACE);
    let position = MultiOutcomePosition {
        market: Pubkey::new_unique(),
        owner: Pubkey::new_unique(),
        free: [u64::MAX; 8],
        locked: [u64::MAX; 8],
        bump: 255,
    };
    bytes.clear();
    position.serialize(&mut bytes).expect("position");
    assert_eq!(MultiOutcomePosition::INIT_SPACE, 193);
    assert_eq!(bytes.len(), MultiOutcomePosition::INIT_SPACE);
    assert_ne!(
        MultiOutcomeMarket::DISCRIMINATOR,
        PredictionMarket::DISCRIMINATOR
    );
    assert_ne!(
        MultiOutcomePosition::DISCRIMINATOR,
        PredictionPosition::DISCRIMINATOR
    );
    assert_eq!(u32::from(OutcomiaError::NothingToRedeem), 6155);
    assert_eq!(u32::from(OutcomiaError::InvalidMultiOutcomeCount), 6156);
}
