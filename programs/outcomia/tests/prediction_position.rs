//! Wallet authorization, market identity and non-destructive ledger creation.
#![allow(clippy::result_large_err)] // Preserve LiteSVM's transaction diagnostics.

use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas,
};
use litesvm::LiteSVM;
use outcomia::state::{
    MarketFees, PredictionMarket, PredictionPosition, PredictionResolutionPhase, PredictionStatus,
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

fn store<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, state: &T) {
    let mut data = Vec::new();
    state.try_serialize(&mut data).unwrap();
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

fn market(svm: &mut LiteSVM, id: u8, status: PredictionStatus) -> Pubkey {
    let (key, bump) = outcomia::derive_prediction_market_pda(&outcomia::ID, &[id; 32]);
    // Host fixtures isolate ledger creation. No mint or vault is installed:
    // position initialization must neither access nor create token claims.
    store(
        svm,
        key,
        &PredictionMarket {
            market_id: [id; 32],
            authority: Pubkey::new_unique(),
            resolver: Pubkey::new_unique(),
            fallback: None,
            collateral_mint: Pubkey::new_unique(),
            collateral_vault: Pubkey::new_unique(),
            metadata: Pubkey::new_unique(),
            question_hash: [1; 32],
            rules_hash: [2; 32],
            rules_uri: "ar://fixture".into(),
            close_ts: 200,
            earliest_resolution_ts: None,
            resolution_delay_seconds: 10,
            resolution_phase: PredictionResolutionPhase::Primary,
            status,
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
    key
}

fn setup() -> (LiteSVM, Keypair, Pubkey) {
    let mut svm = LiteSVM::new();
    svm.add_program(outcomia::ID, PROGRAM).unwrap();
    let owner = Keypair::new();
    svm.airdrop(&owner.pubkey(), 1_000_000_000).unwrap();
    let key = market(&mut svm, 7, PredictionStatus::Draft);
    (svm, owner, key)
}

fn instruction(owner: Pubkey, market: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        outcomia::ID,
        &outcomia::instruction::InitializePredictionPosition {}.data(),
        outcomia::accounts::InitializePredictionPosition {
            owner,
            market,
            position: outcomia::derive_prediction_position_pda(&outcomia::ID, &market, &owner).0,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction) -> litesvm::types::TransactionResult {
    svm.expire_blockhash();
    let message =
        Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &svm.latest_blockhash());
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[payer]).unwrap();
    svm.send_transaction(transaction)
}

#[test]
fn ordinary_wallet_initializes_zeroed_position_without_mutating_the_market() {
    let (mut svm, owner, key) = setup();
    let before = svm.get_account(&key).unwrap();
    let ix = instruction(owner.pubkey(), key);
    let address = ix.accounts[2].pubkey;
    let result = send(&mut svm, &owner, ix);
    assert!(result.is_ok(), "{result:?}");
    let account = svm.get_account(&address).unwrap();
    assert_eq!(account.owner, outcomia::ID);
    assert_eq!(account.data.len(), 8 + PredictionPosition::INIT_SPACE);
    assert!(account.lamports >= svm.minimum_balance_for_rent_exemption(account.data.len()));
    let position = PredictionPosition::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(position.market, key);
    assert_eq!(position.owner, owner.pubkey());
    assert_eq!(
        [
            position.collateral_free,
            position.collateral_locked,
            position.yes_free,
            position.yes_locked,
            position.no_free,
            position.no_locked
        ],
        [0; 6]
    );
    assert_eq!(
        position.bump,
        outcomia::derive_prediction_position_pda(&outcomia::ID, &key, &owner.pubkey()).1
    );
    let after = svm.get_account(&key).unwrap();
    assert_eq!(after.data, before.data);
    assert_eq!(after.lamports, before.lamports);
}

#[test]
fn duplicate_initialization_cannot_reset_existing_claims() {
    let (mut svm, owner, key) = setup();
    let ix = instruction(owner.pubkey(), key);
    let address = ix.accounts[2].pubkey;
    assert!(send(&mut svm, &owner, ix.clone()).is_ok());
    let mut position = PredictionPosition::try_deserialize(
        &mut svm.get_account(&address).unwrap().data.as_slice(),
    )
    .unwrap();
    // Represent a future funded ledger; reinitialization must not erase it.
    position.collateral_free = 11;
    position.collateral_locked = 22;
    position.yes_free = 33;
    position.yes_locked = 44;
    position.no_free = 55;
    position.no_locked = 66;
    store(&mut svm, address, &position);
    let before = svm.get_account(&address).unwrap();
    assert!(send(&mut svm, &owner, ix).is_err());
    let after = svm.get_account(&address).unwrap();
    assert_eq!(after.data, before.data);
    assert_eq!(after.lamports, before.lamports);
}

#[test]
fn position_addresses_separate_wallets_and_markets() {
    let (mut svm, owner, first) = setup();
    let other = Keypair::new();
    svm.airdrop(&other.pubkey(), 1_000_000_000).unwrap();
    let second = market(&mut svm, 8, PredictionStatus::Draft);
    let mut addresses = Vec::new();
    for (wallet, market_key) in [(&owner, first), (&other, first), (&owner, second)] {
        let ix = instruction(wallet.pubkey(), market_key);
        addresses.push(ix.accounts[2].pubkey);
        assert!(send(&mut svm, wallet, ix).is_ok());
    }
    addresses.sort();
    addresses.dedup();
    assert_eq!(addresses.len(), 3);
}

#[test]
fn a_wallet_cannot_initialize_another_wallets_position_address() {
    let (mut svm, owner, key) = setup();
    let victim = Pubkey::new_unique();
    let mut ix = instruction(owner.pubkey(), key);
    let target = outcomia::derive_prediction_position_pda(&outcomia::ID, &key, &victim).0;
    ix.accounts[2].pubkey = target;
    let failure = send(&mut svm, &owner, ix).unwrap_err();
    assert!(failure
        .meta
        .logs
        .iter()
        .any(|log| log.contains("Error Code: ConstraintSeeds")));
    assert!(svm.get_account(&target).is_none());
}

#[test]
fn position_owner_must_sign_even_if_another_wallet_pays_for_the_transaction() {
    let (mut svm, payer, key) = setup();
    let victim = Pubkey::new_unique();
    svm.airdrop(&victim, 1_000_000_000).unwrap();
    let mut ix = instruction(victim, key);
    let target = ix.accounts[2].pubkey;
    ix.accounts[0].is_signer = false;
    let failure = send(&mut svm, &payer, ix).unwrap_err();
    assert!(failure
        .meta
        .logs
        .iter()
        .any(|log| log.contains("Error Code: AccountNotSigner")));
    assert!(svm.get_account(&target).is_none());
}

#[test]
fn market_and_position_seeds_must_match_the_supplied_market() {
    let (mut svm, owner, key) = setup();
    let second = market(&mut svm, 8, PredictionStatus::Draft);
    let mut ix = instruction(owner.pubkey(), key);
    let target = ix.accounts[2].pubkey;
    ix.accounts[1].pubkey = second;
    let failure = send(&mut svm, &owner, ix).unwrap_err();
    assert!(failure
        .meta
        .logs
        .iter()
        .any(|log| log.contains("Error Code: ConstraintSeeds")));
    assert!(svm.get_account(&target).is_none());
}

#[test]
fn invalid_market_accounts_are_rejected_without_creating_a_position() {
    for case in 0..4 {
        let (mut svm, owner, key) = setup();
        let replacement = Pubkey::new_unique();
        match case {
            0 => {} // Missing account.
            1 => {
                // Correct bytes at the wrong canonical address.
                let account = svm.get_account(&key).unwrap();
                svm.set_account(replacement, account).unwrap();
            }
            2 => {
                // Correct data and wrong program owner.
                let mut account = svm.get_account(&key).unwrap();
                account.owner = system_program::ID;
                svm.set_account(replacement, account).unwrap();
            }
            _ => {
                // Program ownership alone is insufficient: type must match.
                store(
                    &mut svm,
                    replacement,
                    &MarketFees {
                        market: key,
                        quote_mint: Pubkey::new_unique(),
                        accrued_quote_fees: 0,
                        bump: 255,
                    },
                );
            }
        }
        let ix = instruction(owner.pubkey(), replacement);
        let target = ix.accounts[2].pubkey;
        assert!(send(&mut svm, &owner, ix).is_err());
        assert!(svm.get_account(&target).is_none());
    }
}

#[test]
fn ledger_creation_is_independent_of_market_trading_status() {
    for status in [
        PredictionStatus::Draft,
        PredictionStatus::Open,
        PredictionStatus::Frozen,
        PredictionStatus::Proposed,
        PredictionStatus::Resolved,
    ] {
        let (mut svm, owner, _) = setup();
        let key = market(&mut svm, 9, status);
        let ix = instruction(owner.pubkey(), key);
        assert!(send(&mut svm, &owner, ix).is_ok());
    }
}
