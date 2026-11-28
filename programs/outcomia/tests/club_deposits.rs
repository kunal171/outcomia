//! LiteSVM coverage for club security deposits (club rules milestone 2a):
//! deposit rules, USDC and SOL deposits, Pyth price checks, the
//! below-minimum gate on club market creation and opening, and the
//! live-market backfill.

#![allow(clippy::result_large_err)]

#[path = "support/club_fixture.rs"]
mod club_fixture;
use club_fixture::*;

#[test]
fn club_accounts_keep_their_size() {
    // The new fields replace reserved space, so existing accounts decode.
    assert_eq!(Club::INIT_SPACE, 280);
    assert_eq!(ClubRulesConfig::INIT_SPACE, 141);
}

#[test]
fn only_the_super_admin_sets_valid_deposit_rules() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    f.fails(
        &owner,
        f.set_deposit_rules(&owner.pubkey(), deposit_rules()),
        "UnauthorizedSuperAdmin",
    );
    let sa = f.super_admin.insecure_clone();
    let invalid: [fn(&mut ClubDepositRules); 6] = [
        |r| r.private_min_deposit_usd = 0,
        |r| r.public_min_deposit_usd = 0,
        |r| r.sol_buffer_bps = 9_999,
        |r| r.max_price_age_seconds = 0,
        |r| r.max_price_conf_bps = 1_001,
        |r| r.sol_usd_feed_id = [0; 32],
    ];
    for edit in invalid {
        let mut rules = deposit_rules();
        edit(&mut rules);
        f.fails(
            &sa,
            f.set_deposit_rules(&sa.pubkey(), rules),
            "InvalidClubDepositRules",
        );
    }
    f.configure();
    let rules: ClubRulesConfig = f.load(&rules_pda());
    assert_eq!(rules.deposit_mint, f.mint);
    assert_eq!(rules.deposit_mint_decimals, 6);
    assert_eq!(rules.public_min_deposit_usd, 200_000_000);
    assert_eq!(rules.sol_usd_feed_id, FEED);
    // Member limits are untouched.
    assert_eq!(rules.public_member_cap, 100);
}

#[test]
fn usdc_deposits_must_reach_the_minimum_and_land_in_the_club_vault() {
    let mut f = Fixture::new();
    let club = f.create_club(1, ClubKind::Public);
    let owner = f.owner.insecure_clone();
    let token = f.token_account(&owner.pubkey(), 500_000_000);
    f.fails(
        &owner,
        f.deposit_usdc(&owner.pubkey(), club, token, 200_000_000),
        "ClubDepositRulesNotSet",
    );
    f.configure();
    f.fails(
        &owner,
        f.deposit_usdc(&owner.pubkey(), club, token, 199_999_999),
        "ClubDepositTooLow",
    );
    f.ok(
        &owner,
        f.deposit_usdc(&owner.pubkey(), club, token, 200_000_000),
    );
    assert_eq!(f.token_amount(&vault_pda(&club)), 200_000_000);
    let state = f.club(1);
    assert_eq!(state.deposit_asset, ClubDepositAsset::Usdc);
    assert_eq!(state.deposit_amount, 200_000_000);
    // Top-ups of any size are fine once the balance is at the minimum.
    f.ok(&owner, f.deposit_usdc(&owner.pubkey(), club, token, 1));
    assert_eq!(f.club(1).deposit_amount, 200_000_001);
    assert_eq!(f.token_amount(&token), 299_999_999);

    // A private club needs only $100.
    let private = f.create_club(2, ClubKind::Private);
    f.ok(
        &owner,
        f.deposit_usdc(&owner.pubkey(), private, token, 100_000_000),
    );
    assert_eq!(f.club(2).deposit_amount, 100_000_000);
}

#[test]
fn only_the_owner_deposits_and_the_token_is_fixed() {
    let mut f = Fixture::new();
    f.configure();
    let club = f.create_club(1, ClubKind::Private);
    let stranger = Keypair::new();
    f.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let token = f.token_account(&stranger.pubkey(), 100_000_000);
    f.fails(
        &stranger,
        f.deposit_usdc(&stranger.pubkey(), club, token, 100_000_000),
        "UnauthorizedClubOwner",
    );
    f.fund_usdc(club, 100_000_000);
    let owner = f.owner.insecure_clone();
    let price = f.price_account(|_| {});
    f.fails(
        &owner,
        f.deposit_sol(&owner.pubkey(), club, price, SOL),
        "ClubDepositAssetMismatch",
    );
}

#[test]
fn sol_deposits_need_the_buffer_at_a_fresh_price() {
    let mut f = Fixture::new();
    f.configure();
    let club = f.create_club(1, ClubKind::Public);
    let owner = f.owner.insecure_clone();
    let price = f.price_account(|_| {});
    // $200 minimum x 120% = $240 = 1.6 SOL at $150.
    f.fails(
        &owner,
        f.deposit_sol(&owner.pubkey(), club, price, 1_599_999_999),
        "ClubDepositTooLow",
    );
    let before = f.svm.get_account(&club).unwrap().lamports;
    f.ok(
        &owner,
        f.deposit_sol(&owner.pubkey(), club, price, 1_600_000_000),
    );
    assert_eq!(
        f.svm.get_account(&club).unwrap().lamports - before,
        1_600_000_000
    );
    let state = f.club(1);
    assert_eq!(state.deposit_asset, ClubDepositAsset::Sol);
    assert_eq!(state.deposit_amount, 1_600_000_000);
    let token = f.token_account(&owner.pubkey(), 200_000_000);
    f.fails(
        &owner,
        f.deposit_usdc(&owner.pubkey(), club, token, 200_000_000),
        "ClubDepositAssetMismatch",
    );
}

/// Changes one field of a valid price update.
type PriceEdit = fn(&mut PriceUpdateV2);

#[test]
fn unusable_prices_are_rejected() {
    let mut f = Fixture::new();
    f.configure();
    let club = f.create_club(1, ClubKind::Private);
    let owner = f.owner.insecure_clone();
    let cases: [(PriceEdit, &str); 5] = [
        (
            |u| u.price_message.publish_time = NOW - 61,
            "InvalidPriceUpdate",
        ),
        (|u| u.price_message.feed_id = [8; 32], "InvalidPriceUpdate"),
        (
            |u| u.verification_level = VerificationLevel::Partial { num_signatures: 5 },
            "InvalidPriceUpdate",
        ),
        (|u| u.price_message.price = -PRICE_150, "InvalidPriceUpdate"),
        // 1.01% of the price, above the 1% limit.
        (
            |u| u.price_message.conf = 151_500_000,
            "PriceConfidenceTooWide",
        ),
    ];
    for (edit, error) in cases {
        let price = f.price_account(edit);
        f.fails(
            &owner,
            f.deposit_sol(&owner.pubkey(), club, price, 2 * SOL),
            error,
        );
    }
    // An account the Pyth receiver does not own is refused outright.
    let fake = f.price_account(|_| {});
    let mut account = f.svm.get_account(&fake).unwrap();
    account.owner = Pubkey::new_unique();
    f.svm.set_account(fake, account).unwrap();
    assert!(f
        .send(&owner, f.deposit_sol(&owner.pubkey(), club, fake, 2 * SOL))
        .is_err());
}

#[test]
fn unfunded_clubs_cannot_create_markets_and_usdc_clubs_count_them() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let club = f.create_club(1, ClubKind::Private);
    f.fails(
        &owner,
        f.create_market(club, 1, None),
        "ClubDepositRulesNotSet",
    );
    f.configure();
    f.fails(
        &owner,
        f.create_market(club, 1, None),
        "ClubDepositBelowMinimum",
    );
    f.fund_usdc(club, 100_000_000);
    f.ok(&owner, f.create_market(club, 1, None));
    f.ok(&owner, f.open_market(club, 1, None));
    f.ok(&owner, f.create_market(club, 2, None));
    let state = f.club(1);
    assert_eq!(state.live_markets, 2);
    assert!(state.live_markets_ready);
}

#[test]
fn sol_clubs_are_valued_at_the_current_price() {
    let mut f = Fixture::new();
    f.configure();
    let owner = f.owner.insecure_clone();
    let club = f.create_club(1, ClubKind::Private);
    let price = f.price_account(|_| {});
    // $100 x 120% = $120 = 0.8 SOL at $150.
    f.ok(
        &owner,
        f.deposit_sol(&owner.pubkey(), club, price, 800_000_000),
    );
    f.fails(
        &owner,
        f.create_market(club, 1, None),
        "ClubPriceUpdateRequired",
    );
    f.ok(&owner, f.create_market(club, 1, Some(price)));
    // At $124 the 0.8 SOL is worth $99.20: below the $100 minimum.
    let low = f.price_account(|u| u.price_message.price = 12_400_000_000);
    f.fails(
        &owner,
        f.open_market(club, 1, Some(low)),
        "ClubDepositBelowMinimum",
    );
    f.fails(
        &owner,
        f.create_market(club, 2, Some(low)),
        "ClubDepositBelowMinimum",
    );
    // At $125 it is worth exactly $100.
    let enough = f.price_account(|u| u.price_message.price = 12_500_000_000);
    f.ok(&owner, f.open_market(club, 1, Some(enough)));
    assert_eq!(f.club(1).live_markets, 1);
}

#[test]
fn the_super_admin_backfills_the_market_count_once() {
    let mut f = Fixture::new();
    let club = f.create_club(1, ClubKind::Private);
    let sa = f.super_admin.insecure_clone();
    // Clubs created with the counter are already ready.
    f.fails(
        &sa,
        f.set_live_markets(&sa.pubkey(), club, 3),
        "ClubMarketCountAlreadySet",
    );
    // A club from before the counter.
    let mut state = f.club(1);
    state.live_markets_ready = false;
    let mut account = f.svm.get_account(&club).unwrap();
    let mut data = Vec::new();
    state.try_serialize(&mut data).unwrap();
    account.data = data;
    f.svm.set_account(club, account).unwrap();
    let owner = f.owner.insecure_clone();
    // Until it is counted the club cannot add markets, so the count stays exact.
    f.configure();
    f.fund_usdc(club, 100_000_000);
    f.fails(
        &owner,
        f.create_market(club, 1, None),
        "ClubMarketCountNotSet",
    );
    f.fails(
        &owner,
        f.set_live_markets(&owner.pubkey(), club, 3),
        "UnauthorizedSuperAdmin",
    );
    f.ok(&sa, f.set_live_markets(&sa.pubkey(), club, 3));
    let state = f.club(1);
    assert_eq!(state.live_markets, 3);
    assert!(state.live_markets_ready);
    f.fails(
        &sa,
        f.set_live_markets(&sa.pubkey(), club, 4),
        "ClubMarketCountAlreadySet",
    );
    // Counted clubs add to the recorded total.
    f.ok(&owner, f.create_market(club, 1, None));
    assert_eq!(f.club(1).live_markets, 4);
}
