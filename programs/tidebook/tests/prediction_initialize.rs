//! Draft creation, authorization, canonical custody and atomic rollback.
#![allow(clippy::result_large_err)] // LiteSVM transaction diagnostics are intentionally rich.

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenState, Mint};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use tidebook::{prediction_config::PredictionMarketConfig, state::*};

const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/tidebook.so"
));

struct Fixture {
    svm: LiteSVM,
    admin: Keypair,
    mint: Pubkey,
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(tidebook::ID, PROGRAM).unwrap();
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
            &[tidebook::ADMIN_SEED, self.admin.pubkey().as_ref()],
            &tidebook::ID,
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
                    owner: tidebook::ID,
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
        let market = tidebook::derive_prediction_market_pda(&tidebook::ID, &[7; 32]).0;
        Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::InitializePredictionMarket {
                market_id: [7; 32],
                config,
                display_name: "Will this proposal pass?".into(),
                collateral_symbol: "tUSDC".into(),
            }
            .data(),
            tidebook::accounts::InitializePredictionMarket {
                authority: self.admin.pubkey(),
                admin_record: Pubkey::find_program_address(
                    &[tidebook::ADMIN_SEED, self.admin.pubkey().as_ref()],
                    &tidebook::ID,
                )
                .0,
                market,
                collateral_mint: self.mint,
                vault_authority: Pubkey::find_program_address(
                    &[tidebook::VAULT_AUTHORITY_SEED, market.as_ref()],
                    &tidebook::ID,
                )
                .0,
                collateral_vault: Pubkey::find_program_address(
                    &[tidebook::VAULT_SEED, market.as_ref(), self.mint.as_ref()],
                    &tidebook::ID,
                )
                .0,
                market_metadata: tidebook::derive_market_metadata_pda(&tidebook::ID, &market).0,
                market_fees: tidebook::derive_market_fees_pda(&tidebook::ID, &market).0,
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    fn send(&mut self, instruction: Instruction) -> litesvm::types::TransactionResult {
        self.svm.expire_blockhash();
        let message = Message::new_with_blockhash(
            &[instruction],
            Some(&self.admin.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[&self.admin])
            .unwrap();
        self.svm.send_transaction(tx)
    }

    fn assert_no_created_accounts(&self, instruction: &Instruction) {
        // Canonical market, vault, metadata and fee PDAs must all roll back.
        for index in [2, 5, 6, 7] {
            assert!(self
                .svm
                .get_account(&instruction.accounts[index].pubkey)
                .is_none());
        }
    }
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
    for index in [3, 4, 5, 6, 7] {
        let mut f = Fixture::new();
        let mut instruction = f.instruction(f.config());
        let canonical = instruction.clone();
        instruction.accounts[index].pubkey = f.admin.pubkey();
        assert!(f.send(instruction).is_err());
        f.assert_no_created_accounts(&canonical);
    }
}
