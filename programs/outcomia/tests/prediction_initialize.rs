//! Draft creation and opening: authority, timing, canonical custody and rollback.
#![allow(clippy::result_large_err)] // LiteSVM transaction diagnostics are intentionally rich.

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenState, Mint};
use litesvm::LiteSVM;
use outcomia::{prediction_config::PredictionMarketConfig, state::*};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/outcomia.so"
));

struct Fixture {
    svm: LiteSVM,
    admin: Keypair,
    mint: Pubkey,
}

impl Fixture {
    fn opening(&self) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::OpenPredictionMarket {}.data(),
            outcomia::accounts::OpenPredictionMarket {
                authority: self.admin.pubkey(),
                market: outcomia::derive_prediction_market_pda(&outcomia::ID, &[7; 32]).0,
                admin_record: Pubkey::find_program_address(
                    &[outcomia::ADMIN_SEED, self.admin.pubkey().as_ref()],
                    &outcomia::ID,
                )
                .0,
            }
            .to_account_metas(None),
        )
    }

    fn market(&self) -> PredictionMarket {
        let key = self.opening().accounts[1].pubkey;
        PredictionMarket::try_deserialize(&mut self.svm.get_account(&key).unwrap().data.as_slice())
            .unwrap()
    }

    fn write_market(&mut self, market: &PredictionMarket) {
        let key = self.opening().accounts[1].pubkey;
        let mut account = self.svm.get_account(&key).unwrap();
        let length = account.data.len();
        account.data.clear();
        market.try_serialize(&mut account.data).unwrap();
        account.data.resize(length, 0);
        self.svm.set_account(key, account).unwrap();
    }

    fn reject_open_unchanged(&mut self, ix: Instruction, code: &str) {
        let key = self.opening().accounts[1].pubkey;
        let before = self.svm.get_account(&key).unwrap();
        let failure = self.send(ix).unwrap_err();
        assert!(
            failure
                .meta
                .logs
                .iter()
                .any(|line| line.contains(&format!("Error Code: {code}"))),
            "{failure:?}"
        );
        assert_eq!(self.svm.get_account(&key).unwrap(), before);
    }

    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM).unwrap();
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 2_000_000_000).unwrap();
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = 100;
        svm.set_sysvar(&clock);
        let mint = Pubkey::new_unique();
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                is_initialized: true,
                decimals: 6,
                ..Mint::default()
            },
            &mut data,
        )
        .unwrap();
        svm.set_account(
            mint,
            Account {
                lamports: svm.minimum_balance_for_rent_exemption(data.len()),
                data,
                owner: anchor_spl::token::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let mut fixture = Self { svm, admin, mint };
        fixture.set_admin(AdminStatus::Active);
        fixture
    }

    fn set_admin(&mut self, status: AdminStatus) {
        let (key, bump) = Pubkey::find_program_address(
            &[outcomia::ADMIN_SEED, self.admin.pubkey().as_ref()],
            &outcomia::ID,
        );
        let mut data = Vec::new();
        AdminRecord {
            authority: self.admin.pubkey(),
            added_by: self.admin.pubkey(),
            status,
            bump,
        }
        .try_serialize(&mut data)
        .unwrap();
        self.svm
            .set_account(
                key,
                Account {
                    lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
                    data,
                    owner: outcomia::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    fn config(&self) -> PredictionMarketConfig {
        PredictionMarketConfig {
            resolver: self.admin.pubkey(),
            fallback: None,
            close_ts: 200,
            earliest_resolution_ts: None,
            resolution_delay_seconds: 10,
            payout_per_contract: 1_000_000,
            price_tick: 10_000,
            rules_uri: format!("ar://{}", "a".repeat(43)),
            question_hash: [1; 32],
            rules_hash: [2; 32],
        }
    }

    fn instruction(&self, config: PredictionMarketConfig) -> Instruction {
        let market = outcomia::derive_prediction_market_pda(&outcomia::ID, &[7; 32]).0;
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializePredictionMarket {
                market_id: [7; 32],
                config,
                display_name: "Will this proposal pass?".into(),
                collateral_symbol: "tUSDC".into(),
            }
            .data(),
            outcomia::accounts::InitializePredictionMarket {
                authority: self.admin.pubkey(),
                admin_record: Pubkey::find_program_address(
                    &[outcomia::ADMIN_SEED, self.admin.pubkey().as_ref()],
                    &outcomia::ID,
                )
                .0,
                market,
                collateral_mint: self.mint,
                vault_authority: Pubkey::find_program_address(
                    &[outcomia::VAULT_AUTHORITY_SEED, market.as_ref()],
                    &outcomia::ID,
                )
                .0,
                collateral_vault: Pubkey::find_program_address(
                    &[outcomia::VAULT_SEED, market.as_ref(), self.mint.as_ref()],
                    &outcomia::ID,
                )
                .0,
                market_metadata: outcomia::derive_market_metadata_pda(&outcomia::ID, &market).0,
                market_fees: outcomia::derive_market_fees_pda(&outcomia::ID, &market).0,
                order_book: outcomia::derive_prediction_book_pda(&outcomia::ID, &market).0,
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn send(&mut self, instruction: Instruction) -> litesvm::types::TransactionResult {
        self.send_many(&[instruction])
    }

    fn send_many(&mut self, instructions: &[Instruction]) -> litesvm::types::TransactionResult {
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            instructions,
            Some(&self.admin.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[&self.admin])
            .unwrap();
        self.svm.send_transaction(tx)
    }

    fn assert_no_created_accounts(&self, instruction: &Instruction) {
        // Market, vault, metadata, fees and book must all roll back together.
        for index in [2, 5, 6, 7, 8] {
            assert!(self
                .svm
                .get_account(&instruction.accounts[index].pubkey)
                .is_none());
        }
    }
}

#[test]
fn opening_an_initialized_draft_changes_only_its_status() {
    let mut f = Fixture::new();
    let mut config = f.config();
    config.fallback = Some(PredictionFallback {
        resolver: Pubkey::new_unique(),
        available_ts: 300,
        deadline_ts: Some(400),
    });
    let initialize = f.instruction(config);
    assert!(f.send(initialize.clone()).is_ok());
    let keys: Vec<_> = [5, 6, 7, 8].map(|i| initialize.accounts[i].pubkey).into();
    let side_accounts: Vec<_> = keys.iter().map(|k| f.svm.get_account(k).unwrap()).collect();
    let mut expected = f.market();
    expected.status = PredictionStatus::Open;
    let ix = f.opening();
    assert!(f.send(ix).is_ok());
    let mut expected_bytes = Vec::new();
    expected.try_serialize(&mut expected_bytes).unwrap();
    let actual = f.svm.get_account(&f.opening().accounts[1].pubkey).unwrap();
    expected_bytes.resize(actual.data.len(), 0);
    assert_eq!(actual.data, expected_bytes);
    for (key, before) in keys.iter().zip(side_accounts) {
        assert_eq!(f.svm.get_account(key).unwrap(), before);
    }
    // Successful opening cannot be replayed or interpreted as a new transition.
    let ix = f.opening();
    f.reject_open_unchanged(ix, "PredictionNotDraft");
}

#[test]
fn opening_checks_the_exact_close_boundary_using_chain_clock() {
    for now in [199, 200, 201] {
        let mut f = Fixture::new();
        let initialize = f.instruction(f.config());
        assert!(f.send(initialize).is_ok());
        let mut clock = f.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = now;
        f.svm.set_sysvar(&clock);
        let ix = f.opening();
        if now < 200 {
            assert!(f.send(ix).is_ok());
            assert_eq!(f.market().status, PredictionStatus::Open);
        } else {
            f.reject_open_unchanged(ix, "PredictionOpeningClosed");
        }
    }
}

#[test]
fn other_lifecycle_statuses_cannot_be_reopened() {
    for status in [
        PredictionStatus::Open,
        PredictionStatus::Frozen,
        PredictionStatus::Proposed,
        PredictionStatus::Resolved,
    ] {
        let mut f = Fixture::new();
        let initialize = f.instruction(f.config());
        assert!(f.send(initialize).is_ok());
        let mut market = f.market();
        market.status = status;
        f.write_market(&market);
        let ix = f.opening();
        f.reject_open_unchanged(ix, "PredictionNotDraft");
    }
}

#[test]
fn opening_requires_creator_and_current_active_admin_membership() {
    let mut f = Fixture::new();
    let initialize = f.instruction(f.config());
    assert!(f.send(initialize).is_ok());
    let creator = std::mem::replace(&mut f.admin, Keypair::new());
    f.svm.airdrop(&f.admin.pubkey(), 1_000_000_000).unwrap();
    f.set_admin(AdminStatus::Active);
    let mut market = f.market();
    market.resolver = f.admin.pubkey();
    f.write_market(&market);
    let ix = f.opening();
    f.reject_open_unchanged(ix, "UnauthorizedPredictionAuthority");
    f.admin = creator;
    let ix = f.opening();
    f.reject_open_unchanged(ix, "PredictionCreatorMustResolve");
    let mut market = f.market();
    market.resolver = f.admin.pubkey();
    f.write_market(&market);
    f.set_admin(AdminStatus::Disabled);
    let ix = f.opening();
    f.reject_open_unchanged(ix, "AdminDisabled");
    f.set_admin(AdminStatus::Active);
    let ix = f.opening();
    assert!(f.send(ix).is_ok());
}

#[test]
fn missing_substituted_and_corrupt_admin_records_cannot_authorize_opening() {
    for case in 0..3 {
        let mut f = Fixture::new();
        let initialize = f.instruction(f.config());
        assert!(f.send(initialize).is_ok());
        let mut ix = f.opening();
        let original = ix.accounts[2].pubkey;
        match case {
            0 => {
                // A deleted admin PDA has no account data, even if its address
                // is the expected canonical PDA.
                let mut record = f.svm.get_account(&original).unwrap();
                record.owner = system_program::ID;
                record.data.clear();
                record.lamports = 0;
                f.svm.set_account(original, record).unwrap();
                f.reject_open_unchanged(ix, "AccountNotInitialized");
            }
            1 => {
                let substitute = Pubkey::new_unique();
                f.svm
                    .set_account(substitute, f.svm.get_account(&original).unwrap())
                    .unwrap();
                ix.accounts[2].pubkey = substitute;
                f.reject_open_unchanged(ix, "ConstraintSeeds");
            }
            _ => {
                let mut record = f.svm.get_account(&original).unwrap();
                let mut admin = AdminRecord::try_deserialize(&mut record.data.as_slice()).unwrap();
                admin.authority = Pubkey::new_unique();
                record.data.clear();
                admin.try_serialize(&mut record.data).unwrap();
                f.svm.set_account(original, record).unwrap();
                f.reject_open_unchanged(ix, "UnauthorizedAdmin");
            }
        }
    }
}

#[test]
fn draft_creation_cannot_delegate_primary_resolution_away_from_creator() {
    let mut f = Fixture::new();
    let mut config = f.config();
    config.resolver = Pubkey::new_unique();
    let ix = f.instruction(config);
    let failure = f.send(ix.clone()).unwrap_err();
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains("PredictionCreatorMustResolve")),
        "{failure:?}"
    );
    f.assert_no_created_accounts(&ix);
}

#[test]
fn unsigned_owner_missing_market_and_noncanonical_market_cannot_open() {
    let mut f = Fixture::new();
    let initialize = f.instruction(f.config());
    assert!(f.send(initialize.clone()).is_ok());
    let mut ix = f.opening();
    let unsigned = Pubkey::new_unique();
    f.svm.airdrop(&unsigned, 1_000_000).unwrap();
    ix.accounts[0].pubkey = unsigned;
    ix.accounts[0].is_signer = false;
    f.reject_open_unchanged(ix, "AccountNotSigner");
    let mut ix = f.opening();
    ix.accounts[1].pubkey = Pubkey::new_unique();
    f.reject_open_unchanged(ix, "AccountNotInitialized");
    let mut ix = f.opening();
    let duplicate = Pubkey::new_unique();
    f.svm
        .set_account(
            duplicate,
            f.svm.get_account(&ix.accounts[1].pubkey).unwrap(),
        )
        .unwrap();
    ix.accounts[1].pubkey = duplicate;
    f.reject_open_unchanged(ix, "ConstraintSeeds");
    let mut ix = f.opening();
    ix.accounts[1].pubkey = initialize.accounts[6].pubkey;
    f.reject_open_unchanged(ix, "AccountDiscriminatorMismatch");
}

#[test]
fn a_later_failure_rolls_back_opening() {
    let mut f = Fixture::new();
    let initialize = f.instruction(f.config());
    assert!(f.send(initialize).is_ok());
    let ix = f.opening();
    let before = f.svm.get_account(&ix.accounts[1].pubkey).unwrap();
    let message = Message::new_with_blockhash(
        &[ix.clone(), ix.clone()],
        Some(&f.admin.pubkey()),
        &f.svm.latest_blockhash(),
    );
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[&f.admin]).unwrap();
    let failure = f.svm.send_transaction(tx).unwrap_err();
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains("PredictionNotDraft")),
        "{failure:?}"
    );
    assert_eq!(f.svm.get_account(&ix.accounts[1].pubkey).unwrap(), before);
}

#[test]
fn active_admin_creates_draft_with_zeroed_accounting_and_pda_controlled_vault() {
    let mut f = Fixture::new();
    let config = f.config();
    let instruction = f.instruction(config.clone());
    let result = f.send(instruction.clone());
    assert!(result.is_ok(), "{result:?}");
    let account = f.svm.get_account(&instruction.accounts[2].pubkey).unwrap();
    assert_eq!(account.data.len(), 8 + PredictionMarket::INIT_SPACE);
    let market = PredictionMarket::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(market.status, PredictionStatus::Draft);
    assert_eq!(market.market_id, [7; 32]);
    assert_eq!(market.authority, f.admin.pubkey());
    assert_eq!(market.resolver, config.resolver);
    assert_eq!(market.fallback, None);
    assert_eq!(market.earliest_resolution_ts, None);
    assert_eq!(market.proposal, None);
    assert_eq!(market.final_outcome, None);
    assert_eq!(market.close_ts, config.close_ts);
    assert_eq!(
        market.resolution_delay_seconds,
        config.resolution_delay_seconds
    );
    assert_eq!(market.question_hash, config.question_hash);
    assert_eq!(market.rules_hash, config.rules_hash);
    assert_eq!(market.rules_uri, config.rules_uri);
    assert_eq!(market.payout_per_contract, 1_000_000);
    assert_eq!(market.price_tick, 10_000);
    assert_eq!(
        (
            market.yes_supply,
            market.no_supply,
            market.backing_reserve,
            market.open_order_count
        ),
        (0, 0, 0, 0)
    );
    let vault_account = f.svm.get_account(&market.collateral_vault).unwrap();
    assert_eq!(vault_account.owner, anchor_spl::token::ID);
    let vault = TokenState::unpack(&vault_account.data).unwrap();
    assert_eq!(vault.mint, f.mint);
    assert_eq!(vault.owner, instruction.accounts[4].pubkey);
    assert_ne!(vault.owner, f.admin.pubkey());
    assert_eq!(vault.amount, 0);
    let metadata = f.svm.get_account(&market.metadata).unwrap();
    let metadata = MarketMetadata::try_deserialize(&mut metadata.data.as_slice()).unwrap();
    assert_eq!(metadata.kind, MarketKind::Prediction);
    assert_eq!(metadata.market, instruction.accounts[2].pubkey);
    assert_eq!(metadata.display_name, "Will this proposal pass?");
    let fees = f.svm.get_account(&instruction.accounts[7].pubkey).unwrap();
    let fees = MarketFees::try_deserialize(&mut fees.data.as_slice()).unwrap();
    assert_eq!(fees.accrued_quote_fees, 0);
    assert_eq!(fees.quote_mint, f.mint);
    let (book_key, book_bump) =
        outcomia::derive_prediction_book_pda(&outcomia::ID, &instruction.accounts[2].pubkey);
    assert_eq!(instruction.accounts[8].pubkey, book_key);
    let book_account = f.svm.get_account(&book_key).unwrap();
    assert_eq!(book_account.owner, outcomia::ID);
    assert_eq!(book_account.data.len(), 8 + PredictionOrderBook::INIT_SPACE);
    assert_eq!(book_account.data.len(), 85);
    let book = PredictionOrderBook::try_deserialize(&mut book_account.data.as_slice()).unwrap();
    assert_eq!(book.market, instruction.accounts[2].pubkey);
    assert_eq!((book.next_order_id, book.bump), (1, book_bump));
    assert_eq!(
        [
            book.yes_best_bid,
            book.yes_best_ask,
            book.no_best_bid,
            book.no_best_ask
        ],
        [None; 4]
    );
    // Duplicate initialization must preserve all original account data.
    let before = account.data;
    assert!(f.send(instruction.clone()).is_err());
    assert_eq!(
        f.svm
            .get_account(&instruction.accounts[2].pubkey)
            .unwrap()
            .data,
        before
    );
}

#[test]
fn optional_fallback_terms_are_stored_without_enabling_trading() {
    for deadline in [None, Some(400)] {
        let mut f = Fixture::new();
        let mut config = f.config();
        config.earliest_resolution_ts = Some(250);
        config.fallback = Some(PredictionFallback {
            resolver: Pubkey::new_unique(),
            available_ts: 300,
            deadline_ts: deadline,
        });
        let instruction = f.instruction(config.clone());
        assert!(f.send(instruction.clone()).is_ok());
        let account = f.svm.get_account(&instruction.accounts[2].pubkey).unwrap();
        let market = PredictionMarket::try_deserialize(&mut account.data.as_slice()).unwrap();
        assert_eq!(market.fallback, config.fallback);
        assert_eq!(market.earliest_resolution_ts, Some(250));
        assert_eq!(market.status, PredictionStatus::Draft);
    }
}

#[test]
fn disabled_and_missing_admins_cannot_create_drafts() {
    let mut f = Fixture::new();
    f.set_admin(AdminStatus::Disabled);
    let instruction = f.instruction(f.config());
    assert!(f.send(instruction.clone()).is_err());
    f.assert_no_created_accounts(&instruction);
    // Substitute a funded wallet with no role record.
    f.admin = Keypair::new();
    f.svm.airdrop(&f.admin.pubkey(), 1_000_000_000).unwrap();
    let instruction = f.instruction(f.config());
    assert!(f.send(instruction.clone()).is_err());
    f.assert_no_created_accounts(&instruction);
}

#[test]
fn invalid_config_and_mint_scaled_payout_roll_back_every_created_account() {
    for case in 0..3 {
        let mut f = Fixture::new();
        let mut config = f.config();
        match case {
            0 => config.close_ts = 100, // Clock, not a client-supplied time.
            1 => config.payout_per_contract = 2_000_000, // Valid pure config, wrong mint scale.
            _ => config.rules_hash = [0; 32],
        }
        let instruction = f.instruction(config);
        assert!(f.send(instruction.clone()).is_err());
        f.assert_no_created_accounts(&instruction);
    }
}

#[test]
fn non_mint_and_noncanonical_vault_or_authority_are_rejected() {
    for index in [3, 4, 5, 6, 7, 8] {
        let mut f = Fixture::new();
        let mut instruction = f.instruction(f.config());
        let canonical = instruction.clone();
        instruction.accounts[index].pubkey = f.admin.pubkey();
        assert!(f.send(instruction).is_err());
        f.assert_no_created_accounts(&canonical);
    }
}

#[test]
fn duplicate_draft_initialization_cannot_reset_a_book_counter() {
    let mut f = Fixture::new();
    let ix = f.instruction(f.config());
    assert!(f.send(ix.clone()).is_ok());
    let book_key = ix.accounts[8].pubkey;
    let mut account = f.svm.get_account(&book_key).unwrap();
    let mut book = PredictionOrderBook::try_deserialize(&mut account.data.as_slice()).unwrap();
    // Model a previously used, currently empty book; IDs must not return to 1.
    book.next_order_id = 42;
    account.data.clear();
    book.try_serialize(&mut account.data).unwrap();
    account.data.resize(8 + PredictionOrderBook::INIT_SPACE, 0);
    f.svm.set_account(book_key, account).unwrap();
    let keys = [2, 5, 6, 7, 8].map(|i| ix.accounts[i].pubkey);
    let before: Vec<_> = keys.iter().map(|k| f.svm.get_account(k).unwrap()).collect();
    assert!(f.send(ix).is_err());
    for (key, account) in keys.iter().zip(before) {
        assert_eq!(f.svm.get_account(key).unwrap(), account);
    }
}

#[test]
fn an_existing_book_cannot_be_overwritten_and_rolls_back_new_side_accounts() {
    let mut f = Fixture::new();
    let ix = f.instruction(f.config());
    let book_key = ix.accounts[8].pubkey;
    let mut data = Vec::new();
    PredictionOrderBook {
        market: ix.accounts[2].pubkey,
        next_order_id: 42,
        yes_best_bid: None,
        yes_best_ask: None,
        no_best_bid: None,
        no_best_ask: None,
        bump: outcomia::derive_prediction_book_pda(&outcomia::ID, &ix.accounts[2].pubkey).1,
    }
    .try_serialize(&mut data)
    .unwrap();
    data.resize(8 + PredictionOrderBook::INIT_SPACE, 0);
    let existing = Account {
        lamports: f.svm.minimum_balance_for_rent_exemption(data.len()),
        data,
        owner: outcomia::ID,
        executable: false,
        rent_epoch: 0,
    };
    f.svm.set_account(book_key, existing.clone()).unwrap();
    assert!(f.send(ix.clone()).is_err());
    assert_eq!(f.svm.get_account(&book_key).unwrap(), existing);
    for index in [2, 5, 6, 7] {
        assert!(f.svm.get_account(&ix.accounts[index].pubkey).is_none());
    }
}

#[test]
fn book_address_is_seed_checked_and_creation_is_atomic_across_a_batch() {
    let mut f = Fixture::new();
    let ix = f.instruction(f.config());
    let mut wrong = ix.clone();
    wrong.accounts[8].pubkey = Pubkey::new_unique();
    let failure = f.send(wrong.clone()).unwrap_err();
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains("ConstraintSeeds")),
        "{failure:?}"
    );
    f.assert_no_created_accounts(&ix);
    assert!(f.svm.get_account(&wrong.accounts[8].pubkey).is_none());
    // A short second instruction reaches an actual account-validation failure,
    // rather than failing packet-size checks before creation can execute.
    let mut invalid_open = f.opening();
    invalid_open.accounts[0].pubkey = f.mint;
    invalid_open.accounts[0].is_signer = false;
    let failure = f.send_many(&[ix.clone(), invalid_open]).unwrap_err();
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains("AccountNotSigner")),
        "{failure:?}"
    );
    // Solana must discard the first market's book and all its other accounts.
    f.assert_no_created_accounts(&ix);
}
