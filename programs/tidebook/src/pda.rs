//! Canonical PDA derivation helpers shared by program tests and clients.

use anchor_lang::prelude::Pubkey;

use crate::{
    constants::{
        MARKET_FEES_SEED, MARKET_METADATA_SEED, PREDICTION_MARKET_SEED, PREDICTION_POSITION_SEED,
        PRICE_LEVEL_SEED, TRADER_BALANCE_SEED,
    },
    state::{OrderSide, PredictionOutcome},
};

/// Separate book root: no existing PredictionMarket layout changes are needed.
pub fn derive_prediction_book_pda(program_id: &Pubkey, market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[crate::PREDICTION_BOOK_SEED, market.as_ref()], program_id)
}

/// A prediction queue is unique to market, outcome, side and raw price.
pub fn derive_prediction_price_level_pda(
    program_id: &Pubkey,
    market: &Pubkey,
    outcome: PredictionOutcome,
    side: OrderSide,
    price: u64,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            crate::PREDICTION_PRICE_LEVEL_SEED,
            market.as_ref(),
            outcome.seed(),
            side.seed(),
            &price.to_le_bytes(),
        ],
        program_id,
    )
}

/// One monotonically allocated ID across both outcomes and both sides.
pub fn derive_prediction_order_pda(
    program_id: &Pubkey,
    market: &Pubkey,
    order_id: u64,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            crate::PREDICTION_ORDER_SEED,
            market.as_ref(),
            &order_id.to_le_bytes(),
        ],
        program_id,
    )
}

/// Derives the unique price-level PDA for one market, side, and price.
///
/// Explicit side bytes and little-endian price encoding are part of the public
/// address contract and must remain identical in Rust tests and web clients.
pub fn derive_price_level_pda(
    program_id: &Pubkey,
    market: &Pubkey,
    side: OrderSide,
    price: u64,
) -> (Pubkey, u8) {
    // Bind the byte array so every seed slice lives through PDA derivation.
    let price_bytes = price.to_le_bytes();

    Pubkey::find_program_address(
        &[
            PRICE_LEVEL_SEED,
            market.as_ref(),
            side.seed(),
            price_bytes.as_ref(),
        ],
        program_id,
    )
}

/// Derives the canonical balance account for one trader in one market.
///
/// Seeds:
/// ["trader_balance", market, owner]
pub fn derive_trader_balance_pda(
    program_id: &Pubkey,
    market: &Pubkey,
    owner: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[TRADER_BALANCE_SEED, market.as_ref(), owner.as_ref()],
        program_id,
    )
}

/// Derives the canonical protocol-fee accumulator for one market.
///
/// Seeds:
/// ["market_fees", market]
pub fn derive_market_fees_pda(program_id: &Pubkey, market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[MARKET_FEES_SEED, market.as_ref()], program_id)
}

/// Derives the optional human-readable identity attached to a market.
///
/// Seeds: ["market_metadata", market]
pub fn derive_market_metadata_pda(program_id: &Pubkey, market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[MARKET_METADATA_SEED, market.as_ref()], program_id)
}

/// Derives a prediction market from its program-wide, creator-supplied ID.
pub fn derive_prediction_market_pda(program_id: &Pubkey, market_id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[PREDICTION_MARKET_SEED, market_id], program_id)
}

/// Derives the prediction-only ledger for one market and wallet.
pub fn derive_prediction_position_pda(
    program_id: &Pubkey,
    market: &Pubkey,
    owner: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[PREDICTION_POSITION_SEED, market.as_ref(), owner.as_ref()],
        program_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prediction_book_order_and_level_match_shared_client_vectors() {
        // Shared with the browser tests: zero program ID, [3;32] market and a
        // deliberately non-palindromic u64 catch namespace/endianness drift.
        let program = Pubkey::default();
        let market = Pubkey::new_from_array([3; 32]);
        let value = 0x0102_0304_0506_0708;
        let book = derive_prediction_book_pda(&program, &market);
        let order = derive_prediction_order_pda(&program, &market, value);
        let level = derive_prediction_price_level_pda(
            &program,
            &market,
            PredictionOutcome::Yes,
            OrderSide::Bid,
            value,
        );
        assert_eq!(
            (book.0.to_string(), book.1),
            ("2o2oe3DTgaHc2MzTxkecU3x23sE4MeNPsTSMC9JAzdY5".into(), 255)
        );
        assert_eq!(
            (order.0.to_string(), order.1),
            ("7aYy4r8ww7hs5bsT52www1gBYaZuVK58rBcJv2k2HoYz".into(), 254)
        );
        assert_eq!(
            (level.0.to_string(), level.1),
            ("7vmpMMVMsgbR3oTLvCSAfftj8PAvHkpDYbujS3u61UkP".into(), 254)
        );
        assert_eq!(
            book.0,
            Pubkey::create_program_address(
                &[b"prediction_book", market.as_ref(), &[book.1]],
                &program
            )
            .unwrap()
        );
        assert_eq!(
            order.0,
            Pubkey::create_program_address(
                &[
                    b"prediction_order",
                    market.as_ref(),
                    &value.to_le_bytes(),
                    &[order.1]
                ],
                &program
            )
            .unwrap()
        );
        assert_eq!(
            level.0,
            Pubkey::create_program_address(
                &[
                    b"prediction_level",
                    market.as_ref(),
                    b"yes",
                    b"bid",
                    &value.to_le_bytes(),
                    &[level.1]
                ],
                &program
            )
            .unwrap()
        );
        let wrong_endian = Pubkey::find_program_address(
            &[b"prediction_order", market.as_ref(), &value.to_be_bytes()],
            &program,
        )
        .0;
        assert_ne!(order.0, wrong_endian);
    }

    #[test]
    fn prediction_queues_are_isolated_by_every_seed_and_from_spot_levels() {
        assert_eq!(PredictionOutcome::Yes.seed(), b"yes");
        assert_eq!(PredictionOutcome::No.seed(), b"no");
        let market = Pubkey::new_unique();
        let queues: Vec<_> = [PredictionOutcome::Yes, PredictionOutcome::No]
            .into_iter()
            .flat_map(|outcome| {
                [OrderSide::Bid, OrderSide::Ask]
                    .into_iter()
                    .map(move |side| {
                        derive_prediction_price_level_pda(
                            &crate::ID,
                            &market,
                            outcome,
                            side,
                            650_000,
                        )
                        .0
                    })
            })
            .collect();
        for (i, queue) in queues.iter().enumerate() {
            for other in &queues[i + 1..] {
                assert_ne!(queue, other);
            }
        }
        let yes_bid = queues[0];
        assert_ne!(
            yes_bid,
            derive_prediction_price_level_pda(
                &crate::ID,
                &market,
                PredictionOutcome::Yes,
                OrderSide::Bid,
                660_000
            )
            .0
        );
        assert_ne!(
            yes_bid,
            derive_prediction_price_level_pda(
                &crate::ID,
                &Pubkey::new_unique(),
                PredictionOutcome::Yes,
                OrderSide::Bid,
                650_000
            )
            .0
        );
        assert_ne!(
            yes_bid,
            derive_prediction_price_level_pda(
                &Pubkey::new_unique(),
                &market,
                PredictionOutcome::Yes,
                OrderSide::Bid,
                650_000
            )
            .0
        );
        assert_ne!(
            yes_bid,
            derive_price_level_pda(&crate::ID, &market, OrderSide::Bid, 650_000).0
        );
    }

    #[test]
    fn prediction_order_ids_and_book_roots_are_market_scoped() {
        let market = Pubkey::new_unique();
        let other_market = Pubkey::new_unique();
        let book = derive_prediction_book_pda(&crate::ID, &market).0;
        assert_ne!(
            book,
            derive_prediction_book_pda(&crate::ID, &other_market).0
        );
        assert_ne!(
            book,
            derive_prediction_book_pda(&Pubkey::new_unique(), &market).0
        );
        let order = derive_prediction_order_pda(&crate::ID, &market, u64::MAX).0;
        assert_ne!(
            order,
            derive_prediction_order_pda(&crate::ID, &market, u64::MAX - 1).0
        );
        assert_ne!(
            order,
            derive_prediction_order_pda(&crate::ID, &other_market, u64::MAX).0
        );
        assert_ne!(
            order,
            derive_prediction_order_pda(&Pubkey::new_unique(), &market, u64::MAX).0
        );
        let spot_order = Pubkey::find_program_address(
            &[b"order", market.as_ref(), &u64::MAX.to_le_bytes()],
            &crate::ID,
        )
        .0;
        assert_ne!(order, spot_order);
        assert_ne!(order, book);
    }

    #[test]
    fn prediction_market_identity_and_signer_seeds_are_stable() {
        let (market, bump) = derive_prediction_market_pda(&crate::ID, &[7; 32]);
        assert_eq!(
            (market, bump),
            derive_prediction_market_pda(&crate::ID, &[7; 32])
        );
        // Literal namespace pins the address contract separately from constants.
        let recreated =
            Pubkey::create_program_address(&[b"prediction_market", &[7; 32], &[bump]], &crate::ID)
                .unwrap();
        assert_eq!(market, recreated);
        assert_ne!(market, derive_prediction_market_pda(&crate::ID, &[8; 32]).0);
        assert_ne!(
            market,
            derive_prediction_market_pda(&Pubkey::new_unique(), &[7; 32]).0
        );
    }

    #[test]
    fn prediction_positions_are_scoped_and_separate_from_spot_balances() {
        let market = derive_prediction_market_pda(&crate::ID, &[7; 32]).0;
        let owner = Pubkey::new_unique();
        let (position, bump) = derive_prediction_position_pda(&crate::ID, &market, &owner);
        let recreated = Pubkey::create_program_address(
            &[
                b"prediction_position",
                market.as_ref(),
                owner.as_ref(),
                &[bump],
            ],
            &crate::ID,
        )
        .unwrap();
        assert_eq!(position, recreated);
        assert_ne!(
            position,
            derive_prediction_position_pda(&crate::ID, &market, &Pubkey::new_unique()).0
        );
        assert_ne!(
            position,
            derive_prediction_position_pda(&crate::ID, &Pubkey::new_unique(), &owner).0
        );
        assert_ne!(
            position,
            derive_trader_balance_pda(&crate::ID, &market, &owner).0
        );
    }

    #[test]
    fn identical_inputs_produce_identical_addresses() {
        let market = Pubkey::new_unique();

        let first = derive_price_level_pda(&crate::ID, &market, OrderSide::Bid, 100);
        let second = derive_price_level_pda(&crate::ID, &market, OrderSide::Bid, 100);

        assert_eq!(first, second);
    }

    #[test]
    fn bid_and_ask_levels_have_different_addresses() {
        let market = Pubkey::new_unique();

        let (bid, _) = derive_price_level_pda(&crate::ID, &market, OrderSide::Bid, 100);
        let (ask, _) = derive_price_level_pda(&crate::ID, &market, OrderSide::Ask, 100);

        assert_ne!(bid, ask);
    }

    #[test]
    fn different_prices_have_different_addresses() {
        let market = Pubkey::new_unique();

        let (first, _) = derive_price_level_pda(&crate::ID, &market, OrderSide::Bid, 100);
        let (second, _) = derive_price_level_pda(&crate::ID, &market, OrderSide::Bid, 110);

        assert_ne!(first, second);
    }

    #[test]
    fn different_markets_have_different_addresses() {
        let first_market = Pubkey::new_unique();
        let second_market = Pubkey::new_unique();

        let (first, _) = derive_price_level_pda(&crate::ID, &first_market, OrderSide::Bid, 100);
        let (second, _) = derive_price_level_pda(&crate::ID, &second_market, OrderSide::Bid, 100);

        assert_ne!(first, second);
    }

    #[test]
    fn trader_balance_pda_is_deterministic() {
        let program_id = Pubkey::new_unique();
        let market = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let first = derive_trader_balance_pda(&program_id, &market, &owner);
        let second = derive_trader_balance_pda(&program_id, &market, &owner);

        assert_eq!(first, second);
    }

    #[test]
    fn trader_balance_pda_changes_for_different_owners() {
        let program_id = Pubkey::new_unique();
        let market = Pubkey::new_unique();

        let first_owner = Pubkey::new_unique();
        let second_owner = Pubkey::new_unique();

        let first = derive_trader_balance_pda(&program_id, &market, &first_owner);
        let second = derive_trader_balance_pda(&program_id, &market, &second_owner);

        assert_ne!(first.0, second.0);
    }

    #[test]
    fn trader_balance_pda_changes_for_different_markets() {
        let program_id = Pubkey::new_unique();
        let owner = Pubkey::new_unique();

        let first_market = Pubkey::new_unique();
        let second_market = Pubkey::new_unique();

        let first = derive_trader_balance_pda(&program_id, &first_market, &owner);
        let second = derive_trader_balance_pda(&program_id, &second_market, &owner);

        assert_ne!(first.0, second.0);
    }

    #[test]
    fn market_fees_pda_uses_the_canonical_namespace() {
        let program_id = Pubkey::new_unique();
        let market = Pubkey::new_unique();

        let derived = derive_market_fees_pda(&program_id, &market);
        let expected =
            Pubkey::find_program_address(&[MARKET_FEES_SEED, market.as_ref()], &program_id);

        assert_eq!(derived, expected);
    }

    #[test]
    fn different_markets_have_different_fee_accounts() {
        let program_id = Pubkey::new_unique();
        let first_market = Pubkey::new_unique();
        let second_market = Pubkey::new_unique();

        let first = derive_market_fees_pda(&program_id, &first_market);
        let second = derive_market_fees_pda(&program_id, &second_market);

        assert_ne!(first.0, second.0);
    }

    #[test]
    fn market_metadata_pda_is_canonical_and_market_specific() {
        let program_id = Pubkey::new_unique();
        let first_market = Pubkey::new_unique();
        let second_market = Pubkey::new_unique();

        let first = derive_market_metadata_pda(&program_id, &first_market);
        let expected = Pubkey::find_program_address(
            &[MARKET_METADATA_SEED, first_market.as_ref()],
            &program_id,
        );
        let second = derive_market_metadata_pda(&program_id, &second_market);

        assert_eq!(first, expected);
        assert_ne!(first.0, second.0);
    }
}
