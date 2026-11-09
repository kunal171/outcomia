//! Prediction cash custody and complete-set conservation through real instructions.
#![allow(clippy::result_large_err)] // Keep LiteSVM's detailed failure metadata.

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, program_pack::Pack},
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenAccount, AccountState, Mint};
use litesvm::LiteSVM;
use outcomia::state::{
    PredictionMarket, PredictionPosition, PredictionResolutionPhase, PredictionStatus,
};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/outcomia.so"
));

fn store<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, value: &T) {
    let mut data = Vec::new();
    value.try_serialize(&mut data).unwrap();
    svm.set_account(
        key,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: outcomia::ID,
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
    fn withdrawal(&self, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::WithdrawPredictionCollateral { amount }.data(),
            outcomia::accounts::WithdrawPredictionCollateral {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                collateral_mint: self.mint,
                destination: self.source,
                vault_authority: self.vault_authority,
                collateral_vault: self.vault,
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        )
    }

    fn complete_set(&self, quantity: u64, split: bool) -> Instruction {
        let data = if split {
            outcomia::instruction::SplitPredictionCompleteSet { quantity }.data()
        } else {
            outcomia::instruction::MergePredictionCompleteSet { quantity }.data()
        };
        Instruction::new_with_bytes(
            outcomia::ID,
            &data,
            outcomia::accounts::PredictionCompleteSet {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
            }
            .to_account_metas(None),
        )
    }

    fn fund_open(&mut self) {
        let ix = self.instruction(20_000_000);
        assert!(self.send(&[ix]).is_ok());
        let mut market = self.market_state();
        market.close_ts = i64::MAX;
        store(&mut self.svm, self.market, &market);
        let opening = Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::OpenPredictionMarket {}.data(),
            outcomia::accounts::OpenPredictionMarket {
                authority: self.owner.pubkey(),
                market: self.market,
                admin_record: Pubkey::find_program_address(
                    &[outcomia::ADMIN_SEED, self.owner.pubkey().as_ref()],
                    &outcomia::ID,
                )
                .0,
            }
            .to_account_metas(None),
        );
        assert!(self.send(&[opening]).is_ok());
    }

    fn assert_backed(&self) {
        let p = self.ledger();
        let m = self.market_state();
        assert_eq!(
            self.token(self.source).amount + self.token(self.vault).amount,
            100_000_000
        );
        assert_eq!(
            self.token(self.vault).amount,
            p.collateral_free + p.collateral_locked + m.backing_reserve
        );
        assert_eq!(m.yes_supply, p.yes_free + p.yes_locked);
        assert_eq!(m.no_supply, p.no_free + p.no_locked);
        assert_eq!(m.yes_supply, m.no_supply);
        assert_eq!(m.backing_reserve, m.yes_supply * m.payout_per_contract);
    }

    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM).unwrap();
        let owner = Keypair::new();
        svm.airdrop(&owner.pubkey(), 1_000_000_000).unwrap();
        let (admin_key, admin_bump) = Pubkey::find_program_address(
            &[outcomia::ADMIN_SEED, owner.pubkey().as_ref()],
            &outcomia::ID,
        );
        store(
            &mut svm,
            admin_key,
            &outcomia::state::AdminRecord {
                authority: owner.pubkey(),
                added_by: owner.pubkey(),
                status: outcomia::state::AdminStatus::Active,
                bump: admin_bump,
            },
        );
        let (market, bump) = outcomia::derive_prediction_market_pda(&outcomia::ID, &[7; 32]);
        let mint = Pubkey::new_unique();
        let vault_authority = Pubkey::find_program_address(
            &[outcomia::VAULT_AUTHORITY_SEED, market.as_ref()],
            &outcomia::ID,
        )
        .0;
        let vault = Pubkey::find_program_address(
            &[outcomia::VAULT_SEED, market.as_ref(), mint.as_ref()],
            &outcomia::ID,
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
                authority: owner.pubkey(),
                resolver: owner.pubkey(),
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
            outcomia::derive_prediction_position_pda(&outcomia::ID, &market, &owner.pubkey());
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
            outcomia::ID,
            &outcomia::instruction::DepositPredictionCollateral { amount }.data(),
            outcomia::accounts::DepositPredictionCollateral {
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
        outcomia::derive_prediction_position_pda(&outcomia::ID, &f.market, &f.owner.pubkey());
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

#[test]
fn deposit_split_partial_merge_and_withdraw_preserve_every_claim() {
    let mut f = Fixture::new();
    f.fund_open();
    f.assert_backed();
    let vault_before = f.svm.get_account(&f.vault).unwrap().data;
    let ix = f.complete_set(7, true);
    assert!(f.send(&[ix]).is_ok());
    assert_eq!(f.ledger().collateral_free, 13_000_000);
    assert_eq!((f.ledger().yes_free, f.ledger().no_free), (7, 7));
    assert_eq!(f.market_state().backing_reserve, 7_000_000);
    assert_eq!(f.svm.get_account(&f.vault).unwrap().data, vault_before);
    f.assert_backed();
    let ix = f.complete_set(3, false);
    assert!(f.send(&[ix]).is_ok());
    assert_eq!((f.ledger().yes_free, f.ledger().no_free), (4, 4));
    assert_eq!(f.ledger().collateral_free, 16_000_000);
    assert_eq!(f.svm.get_account(&f.vault).unwrap().data, vault_before);
    let ix = f.withdrawal(16_000_000);
    assert!(f.send(&[ix]).is_ok());
    assert_eq!(f.ledger().collateral_free, 0);
    assert_eq!(f.token(f.vault).amount, 4_000_000);
    f.assert_backed();
    let before = f.snapshot();
    let merge = f.complete_set(4, false);
    let withdraw = f.withdrawal(4_000_000);
    assert!(f.send(&[merge, withdraw]).is_ok());
    assert_eq!(f.token(f.source).amount, 100_000_000);
    assert_eq!(f.market_state().backing_reserve, 0);
    assert_ne!(f.snapshot(), before);
    f.assert_backed();
}

#[test]
fn withdrawal_is_available_in_every_status_and_does_not_touch_market() {
    for status in [
        PredictionStatus::Draft,
        PredictionStatus::Open,
        PredictionStatus::Frozen,
        PredictionStatus::Proposed,
        PredictionStatus::Resolved,
    ] {
        let mut f = Fixture::new();
        f.fund_open();
        let mut market = f.market_state();
        market.status = status;
        market.close_ts = -1;
        store(&mut f.svm, f.market, &market);
        let before = f.svm.get_account(&f.market).unwrap().data;
        let ix = f.withdrawal(20_000_000);
        assert!(f.send(&[ix]).is_ok());
        assert_eq!(f.svm.get_account(&f.market).unwrap().data, before);
        assert_eq!(f.ledger().collateral_free, 0);
        f.assert_backed();
    }
}

#[test]
fn withdrawal_cannot_spend_zero_locked_cash_or_outcome_reserves() {
    let mut f = Fixture::new();
    f.fund_open();
    let ix = f.complete_set(7, true);
    assert!(f.send(&[ix]).is_ok());
    let mut p = f.ledger();
    p.collateral_free -= 2_000_000;
    p.collateral_locked = 2_000_000;
    store(&mut f.svm, f.position, &p);
    let ix = f.withdrawal(0);
    f.reject_unchanged(ix, "InvalidWithdrawalAmount");
    let ix = f.withdrawal(11_000_001);
    f.reject_unchanged(ix, "InsufficientFreeBalance");
    let ix = f.withdrawal(11_000_000);
    assert!(f.send(&[ix]).is_ok());
    assert_eq!(f.ledger().collateral_locked, 2_000_000);
    assert_eq!(f.market_state().backing_reserve, 7_000_000);
    f.assert_backed();
}

#[test]
fn withdrawal_checks_destination_owner_mint_and_vault_relationships() {
    for owner in [true, false] {
        let mut f = Fixture::new();
        f.fund_open();
        let mut destination = f.token(f.source);
        if owner {
            destination.owner = Pubkey::new_unique();
        } else {
            destination.mint = Pubkey::new_unique();
        }
        store_spl(&mut f.svm, f.source, destination);
        let ix = f.withdrawal(1);
        f.reject_unchanged(
            ix,
            if owner {
                "InvalidWithdrawalDestinationOwner"
            } else {
                "InvalidPredictionCollateralMint"
            },
        );
    }
    for index in [3, 5, 6] {
        let mut f = Fixture::new();
        f.fund_open();
        let mut ix = f.withdrawal(1);
        let replacement = Pubkey::new_unique();
        if let Some(a) = f.svm.get_account(&ix.accounts[index].pubkey) {
            f.svm.set_account(replacement, a).unwrap();
        }
        ix.accounts[index].pubkey = replacement;
        f.reject_unchanged(
            ix,
            if index == 3 {
                "InvalidPredictionCollateralMint"
            } else {
                "ConstraintSeeds"
            },
        );
    }
    let mut f = Fixture::new();
    f.fund_open();
    let mut market = f.market_state();
    market.collateral_vault = Pubkey::new_unique();
    store(&mut f.svm, f.market, &market);
    let ix = f.withdrawal(1);
    f.reject_unchanged(ix, "InvalidPredictionVault");
}

#[test]
fn withdrawal_insufficient_vault_and_frozen_destination_leave_claims_intact() {
    let mut f = Fixture::new();
    f.fund_open();
    let mut vault = f.token(f.vault);
    vault.amount = 0;
    store_spl(&mut f.svm, f.vault, vault);
    let ix = f.withdrawal(1);
    f.reject_unchanged(ix, "InsufficientVaultFunds");
    let mut f = Fixture::new();
    f.fund_open();
    let mut destination = f.token(f.source);
    destination.state = AccountState::Frozen;
    store_spl(&mut f.svm, f.source, destination);
    let before = f.snapshot();
    let ix = f.withdrawal(1);
    assert!(f.send(&[ix]).is_err());
    assert_eq!(f.snapshot(), before);
}

#[test]
fn split_lifecycle_close_boundary_and_merge_lifecycle_are_enforced() {
    for status in [
        PredictionStatus::Draft,
        PredictionStatus::Frozen,
        PredictionStatus::Proposed,
        PredictionStatus::Resolved,
    ] {
        let mut f = Fixture::new();
        f.fund_open();
        let mut m = f.market_state();
        m.status = status;
        store(&mut f.svm, f.market, &m);
        let ix = f.complete_set(1, true);
        f.reject_unchanged(ix, "PredictionSplitUnavailable");
    }
    for close in [-1, 0] {
        let mut f = Fixture::new();
        f.fund_open();
        let mut clock = f.svm.get_sysvar::<anchor_lang::prelude::Clock>();
        clock.unix_timestamp = 0;
        f.svm.set_sysvar(&clock);
        let mut m = f.market_state();
        m.close_ts = close;
        store(&mut f.svm, f.market, &m);
        let ix = f.complete_set(1, true);
        f.reject_unchanged(ix, "PredictionSplitUnavailable");
    }
    for status in [
        PredictionStatus::Draft,
        PredictionStatus::Open,
        PredictionStatus::Frozen,
        PredictionStatus::Proposed,
        PredictionStatus::Resolved,
    ] {
        let mut f = Fixture::new();
        f.fund_open();
        let ix = f.complete_set(2, true);
        assert!(f.send(&[ix]).is_ok());
        let mut m = f.market_state();
        m.status = status;
        m.close_ts = -1;
        store(&mut f.svm, f.market, &m);
        let ix = f.complete_set(2, false);
        if matches!(status, PredictionStatus::Draft | PredictionStatus::Resolved) {
            f.reject_unchanged(ix, "PredictionMergeUnavailable");
        } else {
            assert!(f.send(&[ix]).is_ok());
            f.assert_backed();
        }
    }
}

#[test]
fn complete_set_zero_insufficient_cash_and_locked_outcomes_are_rejected() {
    let mut f = Fixture::new();
    f.fund_open();
    for split in [true, false] {
        let ix = f.complete_set(0, split);
        f.reject_unchanged(ix, "InvalidPredictionContractQuantity");
    }
    let ix = f.complete_set(21, true);
    f.reject_unchanged(ix, "InsufficientFreeBalance");
    let ix = f.complete_set(5, true);
    assert!(f.send(&[ix]).is_ok());
    for yes in [true, false] {
        let mut p = f.ledger();
        if yes {
            p.yes_free = 4;
            p.yes_locked = 1;
        } else {
            p.yes_free = 5;
            p.yes_locked = 0;
            p.no_free = 4;
            p.no_locked = 1;
        }
        store(&mut f.svm, f.position, &p);
        let ix = f.complete_set(5, false);
        f.reject_unchanged(ix, "InsufficientPredictionPositions");
    }
    f.assert_backed();
}

#[test]
fn complete_set_overflow_and_corrupt_backing_fail_atomically() {
    // Each checked field is exercised independently; corrupt host fixtures
    // model accounting damage and must never allow wraparound or partial writes.
    for field in 0..6 {
        let mut f = Fixture::new();
        f.fund_open();
        let mut p = f.ledger();
        let mut m = f.market_state();
        match field {
            0 => m.payout_per_contract = u64::MAX,
            1 => p.yes_free = u64::MAX,
            2 => p.no_free = u64::MAX,
            3 => m.yes_supply = u64::MAX,
            4 => m.no_supply = u64::MAX,
            _ => m.backing_reserve = u64::MAX,
        }
        store(&mut f.svm, f.position, &p);
        store(&mut f.svm, f.market, &m);
        let ix = f.complete_set(2, true);
        f.reject_unchanged(ix, "PredictionAccountingOverflow");
    }
    for field in 0..5 {
        let mut f = Fixture::new();
        f.fund_open();
        let ix = f.complete_set(2, true);
        assert!(f.send(&[ix]).is_ok());
        let mut p = f.ledger();
        let mut m = f.market_state();
        match field {
            0 => p.collateral_free = u64::MAX,
            1 => m.yes_supply = 0,
            2 => m.no_supply = 0,
            3 => m.backing_reserve = 0,
            _ => m.payout_per_contract = u64::MAX,
        }
        store(&mut f.svm, f.position, &p);
        store(&mut f.svm, f.market, &m);
        let ix = f.complete_set(2, false);
        f.reject_unchanged(
            ix,
            match field {
                0 => "FreeBalanceOverflow",
                4 => "PredictionAccountingOverflow",
                _ => "PredictionBackingUnderflow",
            },
        );
    }
}

#[test]
fn withdrawal_and_complete_sets_require_signer_and_canonical_position() {
    for operation in 0..3 {
        for bad in 0..6 {
            let mut f = Fixture::new();
            f.fund_open();
            let split = f.complete_set(2, true);
            assert!(f.send(&[split]).is_ok());
            let mut ix = match operation {
                0 => f.withdrawal(1),
                1 => f.complete_set(1, true),
                _ => f.complete_set(1, false),
            };
            let code = match bad {
                0 => {
                    // A different payer cannot remove the owner's signer check.
                    let victim = Pubkey::new_unique();
                    f.svm.airdrop(&victim, 1_000_000).unwrap();
                    ix.accounts[0].pubkey = victim;
                    ix.accounts[0].is_signer = false;
                    "AccountNotSigner"
                }
                1 | 2 => {
                    let index = bad;
                    let replacement = Pubkey::new_unique();
                    f.svm
                        .set_account(
                            replacement,
                            f.svm.get_account(&ix.accounts[index].pubkey).unwrap(),
                        )
                        .unwrap();
                    ix.accounts[index].pubkey = replacement;
                    "ConstraintSeeds"
                }
                3 => {
                    let mut p = f.ledger();
                    p.owner = Pubkey::new_unique();
                    store(&mut f.svm, f.position, &p);
                    "PredictionPositionOwnerMismatch"
                }
                4 => {
                    let mut p = f.ledger();
                    p.market = Pubkey::new_unique();
                    store(&mut f.svm, f.position, &p);
                    "PredictionPositionMarketMismatch"
                }
                _ => {
                    ix.accounts[2].pubkey = Pubkey::new_unique();
                    "AccountNotInitialized"
                }
            };
            f.reject_unchanged(ix, code);
        }
    }
}

#[test]
fn failed_batch_rolls_back_withdrawal_split_and_merge() {
    for operation in 0..3 {
        let mut f = Fixture::new();
        f.fund_open();
        let split = f.complete_set(5, true);
        assert!(f.send(&[split]).is_ok());
        let first = match operation {
            0 => f.withdrawal(1),
            1 => f.complete_set(1, true),
            _ => f.complete_set(1, false),
        };
        let bad = f.complete_set(u64::MAX, true);
        let before = f.snapshot();
        assert!(f.send(&[first, bad]).is_err());
        assert_eq!(f.snapshot(), before);
    }
}

#[test]
fn two_wallets_share_backing_without_spending_each_others_claims() {
    let mut f = Fixture::new();
    f.fund_open();
    let ix = f.complete_set(7, true);
    assert!(f.send(&[ix]).is_ok());
    let first_owner = std::mem::replace(&mut f.owner, Keypair::new());
    let first_position = f.position;
    let first_source = f.source;
    f.svm.airdrop(&f.owner.pubkey(), 1_000_000_000).unwrap();
    let (position, bump) =
        outcomia::derive_prediction_position_pda(&outcomia::ID, &f.market, &f.owner.pubkey());
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
    // Redistribute existing fixture tokens, keeping the mint supply unchanged.
    let mut first_tokens = f.token(first_source);
    first_tokens.amount -= 20_000_000;
    store_spl(&mut f.svm, first_source, first_tokens);
    f.source = Pubkey::new_unique();
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
    let second_source = f.source;
    let deposit = f.instruction(20_000_000);
    let split = f.complete_set(5, true);
    assert!(f.send(&[deposit, split]).is_ok());
    let mut wrong_position = f.complete_set(1, false);
    wrong_position.accounts[2].pubkey = first_position;
    f.reject_unchanged(wrong_position, "ConstraintSeeds");
    let first_before = f.svm.get_account(&first_position).unwrap().data;
    let merge = f.complete_set(2, false);
    let withdraw = f.withdrawal(17_000_000);
    assert!(f.send(&[merge, withdraw]).is_ok());
    assert_eq!(
        f.svm.get_account(&first_position).unwrap().data,
        first_before
    );
    let second = f.ledger();
    let second_before = f.svm.get_account(&f.position).unwrap().data;
    let second_position = f.position;
    f.owner = first_owner;
    f.position = first_position;
    f.source = first_source;
    let merge = f.complete_set(7, false);
    let withdraw = f.withdrawal(20_000_000);
    assert!(f.send(&[merge, withdraw]).is_ok());
    assert_eq!(
        f.svm.get_account(&second_position).unwrap().data,
        second_before
    );
    let first = f.ledger();
    let m = f.market_state();
    assert_eq!(m.yes_supply, first.yes_free + second.yes_free);
    assert_eq!(m.no_supply, first.no_free + second.no_free);
    assert_eq!(m.backing_reserve, 3_000_000);
    assert_eq!(
        f.token(f.vault).amount,
        first.collateral_free + second.collateral_free + m.backing_reserve
    );
    assert_eq!(
        f.token(first_source).amount + f.token(second_source).amount + f.token(f.vault).amount,
        100_000_000
    );
}

#[test]
fn disabling_creator_admin_role_does_not_block_recovering_free_collateral() {
    let mut f = Fixture::new();
    f.fund_open();
    let (key, bump) = Pubkey::find_program_address(
        &[outcomia::ADMIN_SEED, f.owner.pubkey().as_ref()],
        &outcomia::ID,
    );
    store(
        &mut f.svm,
        key,
        &outcomia::state::AdminRecord {
            authority: f.owner.pubkey(),
            added_by: f.owner.pubkey(),
            status: outcomia::state::AdminStatus::Disabled,
            bump,
        },
    );
    let ix = f.withdrawal(20_000_000);
    assert!(f.send(&[ix]).is_ok());
    f.assert_backed();
    assert_eq!(f.ledger().collateral_free, 0);
}
