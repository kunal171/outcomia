//! LiteSVM coverage for club security deposits (club rules milestone 2a):
//! deposit rules, USDC and SOL deposits, Pyth price checks, the
//! below-minimum gate on club market creation and opening, and the
//! live-market backfill.

#![allow(clippy::result_large_err)]

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenState, AccountState, Mint};
use litesvm::LiteSVM;
use outcomia::{
    constants::*, instructions::ClubDepositRules, prediction_config::PredictionMarketConfig,
    state::*,
};
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const PROGRAM_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/outcomia.so"
));
const FEED: [u8; 32] = [9; 32];
const NOW: i64 = 1_000;
const SOL: u64 = 1_000_000_000;
/// $150.00000000 with exponent -8.
const PRICE_150: i64 = 15_000_000_000;

fn pda(parts: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(parts, &outcomia::ID).0
}
fn rules_pda() -> Pubkey {
    pda(&[CLUB_RULES_CONFIG_SEED])
}
fn club_pda(id: u8) -> Pubkey {
    pda(&[CLUB_SEED, &[id; 32]])
}
fn member_pda(club: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[CLUB_MEMBER_SEED, club.as_ref(), wallet.as_ref()])
}
fn vault_pda(club: &Pubkey) -> Pubkey {
    pda(&[CLUB_DEPOSIT_VAULT_SEED, club.as_ref()])
}
fn market_pda(id: &[u8; 32]) -> Pubkey {
    pda(&[CLUB_PREDICTION_MARKET_SEED, id])
}
fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(outcomia::ID, &data.data(), accounts.to_account_metas(None))
}
fn deposit_rules() -> ClubDepositRules {
    ClubDepositRules {
        private_min_deposit_usd: 100_000_000,
        public_min_deposit_usd: 200_000_000,
        sol_buffer_bps: 12_000,
        sol_usd_feed_id: FEED,
        max_price_age_seconds: 60,
        max_price_conf_bps: 100,
    }
}

struct Fixture {
    svm: LiteSVM,
    super_admin: Keypair,
    owner: Keypair,
    mint: Pubkey,
}

impl Fixture {
    /// Protocol config, club rules (no deposit rules yet), a 6-decimal mint
    /// and a funded owner.
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM_BYTES).unwrap();
        let super_admin = Keypair::new();
        let owner = Keypair::new();
        svm.airdrop(&super_admin.pubkey(), 10 * SOL).unwrap();
        svm.airdrop(&owner.pubkey(), 20 * SOL).unwrap();
        let mint = Pubkey::new_unique();
        let mut f = Fixture {
            svm,
            super_admin,
            owner,
            mint,
        };
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: Some(f.owner.pubkey()).into(),
                supply: 1_000_000_000_000,
                decimals: 6,
                is_initialized: true,
                freeze_authority: None.into(),
            },
            &mut data,
        )
        .unwrap();
        f.store(mint, data, anchor_spl::token::ID);
        let (address, bump) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &outcomia::ID);
        let mut data = Vec::new();
        ProtocolConfig {
            super_admin: f.super_admin.pubkey(),
            taker_fee_bps: 0,
            bump,
        }
        .try_serialize(&mut data)
        .unwrap();
        f.store(address, data, outcomia::ID);
        let sa = f.super_admin.insecure_clone();
        f.ok(
            &sa,
            ix(
                outcomia::accounts::SetClubRules {
                    super_admin: sa.pubkey(),
                    protocol_config: pda(&[PROTOCOL_CONFIG_SEED]),
                    club_rules: rules_pda(),
                    system_program: system_program::ID,
                },
                outcomia::instruction::SetClubRules {
                    public_member_cap: 100,
                    private_member_cap: 10,
                    max_owned_clubs: 5,
                    max_club_admins: 5,
                },
            ),
        );
        f.set_clock(NOW);
        f
    }
    fn store(&mut self, address: Pubkey, data: Vec<u8>, owner: Pubkey) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                Account {
                    lamports,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
    fn set_clock(&mut self, now: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp = now;
        self.svm.set_sysvar(&c);
    }
    fn send(&mut self, signer: &Keypair, ix: Instruction) -> Result<(), Vec<String>> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            &[ix],
            Some(&signer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| e.meta.logs)
    }
    fn ok(&mut self, signer: &Keypair, ix: Instruction) {
        if let Err(logs) = self.send(signer, ix) {
            panic!("transaction should succeed: {logs:#?}");
        }
    }
    fn fails(&mut self, signer: &Keypair, ix: Instruction, error: &str) {
        let logs = self.send(signer, ix).expect_err("transaction should fail");
        let needle = format!("Error Code: {error}.");
        assert!(
            logs.iter().any(|l| l.contains(&needle)),
            "expected {error}: {logs:#?}"
        );
    }
    fn load<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).unwrap();
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }
    fn club(&self, id: u8) -> Club {
        self.load(&club_pda(id))
    }
    fn set_deposit_rules(&self, signer: &Pubkey, rules: ClubDepositRules) -> Instruction {
        ix(
            outcomia::accounts::SetClubDepositRules {
                super_admin: *signer,
                protocol_config: pda(&[PROTOCOL_CONFIG_SEED]),
                club_rules: rules_pda(),
                deposit_mint: self.mint,
            },
            outcomia::instruction::SetClubDepositRules { rules },
        )
    }
    fn configure(&mut self) {
        let sa = self.super_admin.insecure_clone();
        self.ok(&sa, self.set_deposit_rules(&sa.pubkey(), deposit_rules()));
    }
    fn create_club(&mut self, id: u8, kind: ClubKind) -> Pubkey {
        let owner = self.owner.insecure_clone();
        let club = club_pda(id);
        self.ok(
            &owner,
            ix(
                outcomia::accounts::CreateClub {
                    owner: owner.pubkey(),
                    club_rules: rules_pda(),
                    owner_record: pda(&[CLUB_OWNER_SEED, owner.pubkey().as_ref()]),
                    club,
                    owner_member: member_pda(&club, &owner.pubkey()),
                    system_program: system_program::ID,
                },
                outcomia::instruction::CreateClub {
                    club_id: [id; 32],
                    name: format!("Club {id}"),
                    kind,
                },
            ),
        );
        club
    }
    /// A token account of the deposit mint owned by `owner`.
    fn token_account(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let token = Pubkey::new_unique();
        let mut data = vec![0; TokenState::LEN];
        TokenState::pack(
            TokenState {
                mint: self.mint,
                owner: *owner,
                amount,
                delegate: None.into(),
                state: AccountState::Initialized,
                is_native: None.into(),
                delegated_amount: 0,
                close_authority: None.into(),
            },
            &mut data,
        )
        .unwrap();
        self.store(token, data, anchor_spl::token::ID);
        token
    }
    fn token_amount(&self, address: &Pubkey) -> u64 {
        let account = self.svm.get_account(address).unwrap();
        TokenState::unpack(&account.data).unwrap().amount
    }
    fn deposit_usdc(
        &self,
        owner: &Pubkey,
        club: Pubkey,
        token: Pubkey,
        amount: u64,
    ) -> Instruction {
        ix(
            outcomia::accounts::DepositClubUsdc {
                owner: *owner,
                club,
                club_rules: rules_pda(),
                deposit_mint: self.mint,
                owner_token: token,
                deposit_vault: vault_pda(&club),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            },
            outcomia::instruction::DepositClubUsdc { amount },
        )
    }
    fn deposit_sol(
        &self,
        owner: &Pubkey,
        club: Pubkey,
        price: Pubkey,
        lamports: u64,
    ) -> Instruction {
        ix(
            outcomia::accounts::DepositClubSol {
                owner: *owner,
                club,
                club_rules: rules_pda(),
                price_update: price,
                system_program: system_program::ID,
            },
            outcomia::instruction::DepositClubSol { lamports },
        )
    }
    /// Writes a Pyth price account, owned by the Pyth receiver program.
    fn price_account(&mut self, edit: impl FnOnce(&mut PriceUpdateV2)) -> Pubkey {
        let mut update = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id: FEED,
                price: PRICE_150,
                conf: 1_000_000,
                exponent: -8,
                publish_time: NOW - 5,
                prev_publish_time: NOW - 6,
                ema_price: PRICE_150,
                ema_conf: 1_000_000,
            },
            posted_slot: 1,
        };
        edit(&mut update);
        let mut data = Vec::new();
        update.try_serialize(&mut data).unwrap();
        let address = Pubkey::new_unique();
        self.store(address, data, pyth_solana_receiver_sdk::ID);
        address
    }
    fn fund_usdc(&mut self, club: Pubkey, amount: u64) {
        let owner = self.owner.insecure_clone();
        let token = self.token_account(&owner.pubkey(), amount);
        self.ok(
            &owner,
            self.deposit_usdc(&owner.pubkey(), club, token, amount),
        );
    }
    fn create_market(&self, club: Pubkey, id: u8, price: Option<Pubkey>) -> Instruction {
        let creator = self.owner.pubkey();
        let market = market_pda(&[id; 32]);
        ix(
            outcomia::accounts::CreateClubPredictionMarket {
                creator,
                club,
                creator_member: member_pda(&club, &creator),
                market,
                club_market: pda(&[CLUB_MARKET_SEED, market.as_ref()]),
                collateral_mint: self.mint,
                vault_authority: pda(&[VAULT_AUTHORITY_SEED, market.as_ref()]),
                collateral_vault: pda(&[VAULT_SEED, market.as_ref(), self.mint.as_ref()]),
                market_metadata: pda(&[MARKET_METADATA_SEED, market.as_ref()]),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
                club_rules: rules_pda(),
                price_update: price,
            },
            outcomia::instruction::CreateClubPredictionMarket {
                market_id: [id; 32],
                config: PredictionMarketConfig {
                    resolver: creator,
                    fallback: None,
                    close_ts: NOW + 10_000,
                    earliest_resolution_ts: None,
                    resolution_delay_seconds: 10,
                    payout_per_contract: 1_000_000,
                    price_tick: 10_000,
                    rules_uri: format!("ar://{}", "a".repeat(43)),
                    question_hash: [1; 32],
                    rules_hash: [2; 32],
                },
                display_name: "Will it rain?".into(),
                collateral_symbol: "USDC".into(),
                access: ClubMarketAccess::MembersOnly,
            },
        )
    }
    fn open_market(&self, club: Pubkey, id: u8, price: Option<Pubkey>) -> Instruction {
        let market = market_pda(&[id; 32]);
        ix(
            outcomia::accounts::OpenClubPredictionMarket {
                actor: self.owner.pubkey(),
                club_market: pda(&[CLUB_MARKET_SEED, market.as_ref()]),
                market,
                actor_member: member_pda(&club, &self.owner.pubkey()),
                club,
                club_rules: rules_pda(),
                price_update: price,
            },
            outcomia::instruction::OpenClubPredictionMarket {},
        )
    }
    fn set_live_markets(&self, signer: &Pubkey, club: Pubkey, count: u32) -> Instruction {
        ix(
            outcomia::accounts::SetClubLiveMarkets {
                super_admin: *signer,
                protocol_config: pda(&[PROTOCOL_CONFIG_SEED]),
                club,
            },
            outcomia::instruction::SetClubLiveMarkets { count },
        )
    }
}

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
