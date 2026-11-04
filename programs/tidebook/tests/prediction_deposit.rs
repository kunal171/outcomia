//! Collateral custody, ledger credit and rollback through the actual SPL CPI.
#![allow(clippy::result_large_err)] // Keep LiteSVM's detailed failure metadata.

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, program_pack::Pack},
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenAccount, AccountState, Mint};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use tidebook::state::{
    PredictionMarket, PredictionPosition, PredictionResolutionPhase, PredictionStatus,
};

const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/tidebook.so"
));

fn store<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, value: &T) {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    svm.set_account(
        key,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: tidebook::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn store_spl<T: Pack>(svm: &mut LiteSVM, key: Pubkey, value: T) {
    let mut data = vec![0; T::LEN];
    T::pack(value, &mut data).unwrap();
    svm.set_account(
        key,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: anchor_spl::token::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

struct Fixture {
    svm: LiteSVM,
    owner: Keypair,
    market: Pubkey,
    position: Pubkey,
    mint: Pubkey,
    source: Pubkey,
    vault: Pubkey,
    vault_authority: Pubkey,
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(tidebook::ID, PROGRAM).unwrap();
        let owner = Keypair::new();
        svm.airdrop(&owner.pubkey(), 1_000_000_000).unwrap();
        let (market, bump) = tidebook::derive_prediction_market_pda(&tidebook::ID, &[7; 32]);
        let mint = Pubkey::new_unique();
        let vault_authority = Pubkey::find_program_address(
            &[tidebook::VAULT_AUTHORITY_SEED, market.as_ref()],
            &tidebook::ID,
        )
        .0;
        let vault = Pubkey::find_program_address(
            &[tidebook::VAULT_SEED, market.as_ref(), mint.as_ref()],
            &tidebook::ID,
        )
        .0;
        store_spl(
            &mut svm,
            mint,
            Mint {
                decimals: 6,
                is_initialized: true,
                supply: 100_000_000,
                ..Mint::default()
            },
        );
        let source = Pubkey::new_unique();
        store_spl(
            &mut svm,
            source,
            TokenAccount {
                mint,
                owner: owner.pubkey(),
                amount: 100_000_000,
                state: AccountState::Initialized,
                ..TokenAccount::default()
            },
        );
        store_spl(
            &mut svm,
            vault,
            TokenAccount {
                mint,
                owner: vault_authority,
                state: AccountState::Initialized,
                ..TokenAccount::default()
            },
        );
        store(
            &mut svm,
            market,
            &PredictionMarket {
                market_id: [7; 32],
                authority: Pubkey::new_unique(),
                resolver: Pubkey::new_unique(),
                fallback: None,
                collateral_mint: mint,
                collateral_vault: vault,
                metadata: Pubkey::new_unique(),
                question_hash: [1; 32],
                rules_hash: [2; 32],
                rules_uri: "ar://fixture".into(),
                close_ts: 200,
                earliest_resolution_ts: None,
                resolution_delay_seconds: 10,
                resolution_phase: PredictionResolutionPhase::Primary,
                status: PredictionStatus::Draft,
                proposal: None,
                final_outcome: None,
                payout_per_contract: 1_000_000,
                price_tick: 10_000,
                yes_supply: 0,
                no_supply: 0,
                backing_reserve: 0,
                open_order_count: 0,
                bump,
            },
        );
        let (position, bump) =
            tidebook::derive_prediction_position_pda(&tidebook::ID, &market, &owner.pubkey());
        store(
            &mut svm,
            position,
            &PredictionPosition {
                market,
                owner: owner.pubkey(),
                collateral_free: 0,
                collateral_locked: 0,
                yes_free: 0,
                yes_locked: 0,
                no_free: 0,
                no_locked: 0,
                bump,
            },
        );
        Self {
            svm,
            owner,
            market,
            position,
            mint,
            source,
            vault,
            vault_authority,
        }
    }

    fn instruction(&self, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::DepositPredictionCollateral { amount }.data(),
            tidebook::accounts::DepositPredictionCollateral {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                collateral_mint: self.mint,
                source: self.source,
                vault_authority: self.vault_authority,
                collateral_vault: self.vault,
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        )
    }

    fn send(&mut self, instructions: &[Instruction]) -> litesvm::types::TransactionResult {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            instructions,
            Some(&self.owner.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx =
            VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.owner]).unwrap();
        self.svm.send_transaction(tx)
    }

    fn ledger(&self) -> PredictionPosition {
        PredictionPosition::try_deserialize(
            &mut self
                .svm
                .get_account(&self.position)
                .unwrap()
                .data
                .as_slice(),
        )
        .unwrap()
    }

    fn market_state(&self) -> PredictionMarket {
        PredictionMarket::try_deserialize(
            &mut self.svm.get_account(&self.market).unwrap().data.as_slice(),
        )
        .unwrap()
    }

    fn token(&self, key: Pubkey) -> TokenAccount {
        TokenAccount::unpack(&self.svm.get_account(&key).unwrap().data).unwrap()
    }

    fn snapshot(&self) -> Vec<Vec<u8>> {
        [self.source, self.vault, self.position, self.market]
            .iter()
            .map(|key| self.svm.get_account(key).unwrap().data)
            .collect()
    }

    fn reject_unchanged(&mut self, ix: Instruction, code: &str) {
        let before = self.snapshot();
        let failure = self.send(&[ix]).unwrap_err();
        assert!(
            failure
                .meta
                .logs
                .iter()
                .any(|line| line.contains(&format!("Error Code: {code}"))),
            "{failure:?}"
        );
        assert_eq!(self.snapshot(), before);
    }
}

#[test]
fn deposit_moves_exact_atoms_and_credits_only_free_collateral() {
    let mut f = Fixture::new();
    // Represent an already funded book so accidentally zeroing locked cash
    // or outcome buckets cannot pass a zero-only assertion. All claims are
    // backed: 2 collateral tokens locked + 7 complete outcome pairs reserved.
    let mut p = f.ledger();
    p.collateral_locked = 2_000_000;
    p.yes_free = 3;
    p.yes_locked = 4;
    p.no_free = 4;
    p.no_locked = 3;
    store(&mut f.svm, f.position, &p);
    let mut market = f.market_state();
    market.yes_supply = 7;
    market.no_supply = 7;
    market.backing_reserve = 7_000_000;
    market.open_order_count = 3;
    store(&mut f.svm, f.market, &market);
    let mut vault = f.token(f.vault);
    vault.amount = 9_000_000;
    store_spl(&mut f.svm, f.vault, vault);
    let mut mint = Mint::unpack(&f.svm.get_account(&f.mint).unwrap().data).unwrap();
    mint.supply += 9_000_000;
    store_spl(&mut f.svm, f.mint, mint);
    let market_before = f.svm.get_account(&f.market).unwrap().data;
    for amount in [10_000_000, 5_000_000] {
        let ix = f.instruction(amount);
        let result = f.send(&[ix]);
        assert!(result.is_ok(), "{result:?}");
    }
    assert_eq!(f.token(f.source).amount, 85_000_000);
    assert_eq!(f.token(f.vault).amount, 24_000_000);
    let p = f.ledger();
    assert_eq!(p.collateral_free, 15_000_000);
    assert_eq!(
        [
            p.collateral_locked,
            p.yes_free,
            p.yes_locked,
            p.no_free,
            p.no_locked
        ],
        [2_000_000, 3, 4, 4, 3]
    );
    assert_eq!(
        f.token(f.vault).amount,
        p.collateral_free + p.collateral_locked + market.backing_reserve
    );
    assert_eq!(f.svm.get_account(&f.market).unwrap().data, market_before);
}

#[test]
fn deposit_is_available_before_resolution_in_each_lifecycle_status() {
    for status in [
        PredictionStatus::Draft,
        PredictionStatus::Open,
        PredictionStatus::Frozen,
        PredictionStatus::Proposed,
    ] {
        let mut f = Fixture::new();
        let mut market = f.market_state();
        market.status = status;
        store(&mut f.svm, f.market, &market);
        let ix = f.instruction(1);
        assert!(f.send(&[ix]).is_ok());
    }
    let mut f = Fixture::new();
    let mut market = f.market_state();
    market.status = PredictionStatus::Resolved;
    store(&mut f.svm, f.market, &market);
    let ix = f.instruction(1);
    f.reject_unchanged(ix, "PredictionDepositAfterResolution");
}

#[test]
fn zero_insufficient_funds_and_free_balance_overflow_are_atomic() {
    let mut f = Fixture::new();
    let ix = f.instruction(0);
    f.reject_unchanged(ix, "InvalidDepositAmount");
    let ix = f.instruction(100_000_001);
    f.reject_unchanged(ix, "InsufficientDepositFunds");
    let mut ledger = f.ledger();
    ledger.collateral_free = u64::MAX;
    store(&mut f.svm, f.position, &ledger);
    let ix = f.instruction(1);
    f.reject_unchanged(ix, "FreeBalanceOverflow");
}

#[test]
fn another_wallets_source_and_different_source_mint_are_rejected() {
    for wrong_owner in [true, false] {
        let mut f = Fixture::new();
        let mut token = f.token(f.source);
        if wrong_owner {
            token.owner = Pubkey::new_unique();
        } else {
            token.mint = Pubkey::new_unique();
        }
        store_spl(&mut f.svm, f.source, token);
        let ix = f.instruction(1);
        f.reject_unchanged(
            ix,
            if wrong_owner {
                "InvalidPredictionTokenOwner"
            } else {
                "InvalidPredictionCollateralMint"
            },
        );
    }
}

#[test]
fn mismatched_mint_vault_and_signing_authority_cannot_redirect_custody() {
    for index in [3, 5, 6] {
        let mut f = Fixture::new();
        let mut ix = f.instruction(1);
        let replacement = Pubkey::new_unique();
        let original = ix.accounts[index].pubkey;
        if let Some(account) = f.svm.get_account(&original) {
            f.svm.set_account(replacement, account).unwrap();
        }
        ix.accounts[index].pubkey = replacement;
        f.reject_unchanged(
            ix,
            match index {
                3 => "InvalidPredictionCollateralMint",
                // Anchor checks canonical seeds before the stored address.
                _ => "ConstraintSeeds",
            },
        );
    }
    // The provided vault can be canonical while a corrupted market stores a
    // different vault address. The stored relationship is checked separately.
    let mut f = Fixture::new();
    let mut market = f.market_state();
    market.collateral_vault = Pubkey::new_unique();
    store(&mut f.svm, f.market, &market);
    let ix = f.instruction(1);
    f.reject_unchanged(ix, "InvalidPredictionVault");
}

#[test]
fn wrong_ledger_address_and_corrupted_market_or_owner_fields_are_rejected() {
    let mut f = Fixture::new();
    let mut ix = f.instruction(1);
    let replacement = Pubkey::new_unique();
    f.svm
        .set_account(replacement, f.svm.get_account(&f.position).unwrap())
        .unwrap();
    ix.accounts[2].pubkey = replacement;
    f.reject_unchanged(ix, "ConstraintSeeds");
    for wrong_owner in [true, false] {
        let mut f = Fixture::new();
        let mut p = f.ledger();
        if wrong_owner {
            p.owner = Pubkey::new_unique();
        } else {
            p.market = Pubkey::new_unique();
        }
        store(&mut f.svm, f.position, &p);
        let ix = f.instruction(1);
        f.reject_unchanged(
            ix,
            if wrong_owner {
                "PredictionPositionOwnerMismatch"
            } else {
                "PredictionPositionMarketMismatch"
            },
        );
    }
}

#[test]
fn frozen_token_cpi_failure_does_not_credit_the_ledger() {
    let mut f = Fixture::new();
    let mut source = f.token(f.source);
    source.state = AccountState::Frozen;
    store_spl(&mut f.svm, f.source, source);
    let before = f.snapshot();
    let ix = f.instruction(1);
    let failure = f.send(&[ix]).unwrap_err();
    assert!(failure
        .meta
        .logs
        .iter()
        .any(|line| line.contains("Program Tokenkeg") && line.contains("failed")));
    assert_eq!(f.snapshot(), before);
}

#[test]
fn unsigned_owner_missing_position_and_noncanonical_market_are_rejected() {
    let mut f = Fixture::new();
    let mut ix = f.instruction(1);
    let victim = Pubkey::new_unique();
    f.svm.airdrop(&victim, 1_000_000_000).unwrap();
    ix.accounts[0].pubkey = victim;
    ix.accounts[0].is_signer = false;
    f.reject_unchanged(ix, "AccountNotSigner");

    let mut ix = f.instruction(1);
    ix.accounts[2].pubkey = Pubkey::new_unique();
    f.reject_unchanged(ix, "AccountNotInitialized");

    let mut ix = f.instruction(1);
    let wrong_market = Pubkey::new_unique();
    f.svm
        .set_account(wrong_market, f.svm.get_account(&f.market).unwrap())
        .unwrap();
    ix.accounts[1].pubkey = wrong_market;
    f.reject_unchanged(ix, "ConstraintSeeds");
}

#[test]
fn a_failed_second_deposit_rolls_back_the_first_transfer_and_credit() {
    let mut f = Fixture::new();
    let before = f.snapshot();
    let first = f.instruction(60_000_000);
    let second = f.instruction(60_000_000);
    assert!(f.send(&[first, second]).is_err());
    assert_eq!(f.snapshot(), before);
}

#[test]
fn multiple_wallet_claims_sum_to_the_vault_balance() {
    let mut f = Fixture::new();
    let ix = f.instruction(10_000_000);
    assert!(f.send(&[ix]).is_ok());
    let first = f.ledger().collateral_free;
    f.owner = Keypair::new();
    f.svm.airdrop(&f.owner.pubkey(), 1_000_000_000).unwrap();
    let (position, bump) =
        tidebook::derive_prediction_position_pda(&tidebook::ID, &f.market, &f.owner.pubkey());
    f.position = position;
    store(
        &mut f.svm,
        position,
        &PredictionPosition {
            market: f.market,
            owner: f.owner.pubkey(),
            collateral_free: 0,
            collateral_locked: 0,
            yes_free: 0,
            yes_locked: 0,
            no_free: 0,
            no_locked: 0,
            bump,
        },
    );
    f.source = Pubkey::new_unique();
    let mut mint = Mint::unpack(&f.svm.get_account(&f.mint).unwrap().data).unwrap();
    mint.supply += 20_000_000;
    store_spl(&mut f.svm, f.mint, mint);
    store_spl(
        &mut f.svm,
        f.source,
        TokenAccount {
            mint: f.mint,
            owner: f.owner.pubkey(),
            amount: 20_000_000,
            state: AccountState::Initialized,
            ..TokenAccount::default()
        },
    );
    let ix = f.instruction(20_000_000);
    assert!(f.send(&[ix]).is_ok());
    assert_eq!(f.token(f.vault).amount, first + f.ledger().collateral_free);
}
