//! Empty-side orders through actual draft/open/deposit/split setup.
//! The trader has no admin record; snapshots exclude only SOL transaction fees.
#![allow(clippy::result_large_err)]
use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenAccount, AccountState, Mint};
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

fn send(
    svm: &mut LiteSVM,
    signer: &Keypair,
    instructions: &[Instruction],
) -> litesvm::types::TransactionResult {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(
        instructions,
        Some(&signer.pubkey()),
        &svm.latest_blockhash(),
    );
    svm.send_transaction(
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap(),
    )
}
fn account(svm: &mut LiteSVM, key: Pubkey, data: Vec<u8>, owner: Pubkey) {
    svm.set_account(
        key,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}
fn read<T: AccountDeserialize>(svm: &LiteSVM, key: Pubkey) -> T {
    T::try_deserialize(&mut svm.get_account(&key).unwrap().data.as_slice()).unwrap()
}
fn write<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, value: &T) {
    let mut stored = svm.get_account(&key).unwrap();
    let size = stored.data.len();
    stored.data.clear();
    value.try_serialize(&mut stored.data).unwrap();
    stored.data.resize(size, 0);
    svm.set_account(key, stored).unwrap();
}
struct Fixture {
    svm: LiteSVM,
    owner: Keypair,
    market: Pubkey,
    book: Pubkey,
    position: Pubkey,
    vault: Pubkey,
    source: Pubkey,
    fees: Pubkey,
}
impl Fixture {
    fn append(
        &self,
        outcome: PredictionOutcome,
        side: OrderSide,
        price: u64,
        quantity: u64,
        order_id: u64,
        tail: Pubkey,
    ) -> Instruction {
        Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::AppendPredictionOrder {
                order_id,
                outcome,
                side,
                price,
                quantity,
            }
            .data(),
            tidebook::accounts::AppendPredictionOrder {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                order_book: self.book,
                price_level: tidebook::derive_prediction_price_level_pda(
                    &tidebook::ID,
                    &self.market,
                    outcome,
                    side,
                    price,
                )
                .0,
                tail_order: tail,
                order: tidebook::derive_prediction_order_pda(&tidebook::ID, &self.market, order_id)
                    .0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }
    fn reject_append(&mut self, ix: Instruction, code: &str) {
        let before = self.snapshot();
        let keys = [
            ix.accounts[4].pubkey,
            ix.accounts[5].pubkey,
            ix.accounts[6].pubkey,
        ];
        let accounts: Vec<_> = keys.iter().map(|key| self.svm.get_account(key)).collect();
        let failure = send(&mut self.svm, &self.owner, std::slice::from_ref(&ix)).unwrap_err();
        assert!(
            failure
                .meta
                .logs
                .iter()
                .any(|line| line.contains(&format!("Error Code: {code}"))),
            "{failure:?}"
        );
        assert_eq!(self.snapshot(), before);
        for (key, before) in keys.iter().zip(accounts) {
            assert_eq!(self.svm.get_account(key), before);
        }
    }
    fn switch_to_funded_trader(&mut self) {
        self.owner = Keypair::new();
        self.svm
            .airdrop(&self.owner.pubkey(), 2_000_000_000)
            .unwrap();
        let mint_key = TokenAccount::unpack(&self.svm.get_account(&self.vault).unwrap().data)
            .unwrap()
            .mint;
        // Model another faucet grant without changing existing trader claims.
        let mut mint = Mint::unpack(&self.svm.get_account(&mint_key).unwrap().data).unwrap();
        mint.supply += 20_000_000;
        let mut data = vec![0; Mint::LEN];
        Mint::pack(mint, &mut data).unwrap();
        account(&mut self.svm, mint_key, data, anchor_spl::token::ID);
        let source = Pubkey::new_unique();
        let mut data = vec![0; TokenAccount::LEN];
        TokenAccount::pack(
            TokenAccount {
                mint: mint_key,
                owner: self.owner.pubkey(),
                amount: 20_000_000,
                state: AccountState::Initialized,
                ..TokenAccount::default()
            },
            &mut data,
        )
        .unwrap();
        account(&mut self.svm, source, data, anchor_spl::token::ID);
        self.position = tidebook::derive_prediction_position_pda(
            &tidebook::ID,
            &self.market,
            &self.owner.pubkey(),
        )
        .0;
        let init = Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::InitializePredictionPosition {}.data(),
            tidebook::accounts::InitializePredictionPosition {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let deposit = Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::DepositPredictionCollateral { amount: 20_000_000 }.data(),
            tidebook::accounts::DepositPredictionCollateral {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                collateral_mint: mint_key,
                source,
                vault_authority: Pubkey::find_program_address(
                    &[b"vault-authority", self.market.as_ref()],
                    &tidebook::ID,
                )
                .0,
                collateral_vault: self.vault,
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        );
        let split = Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::SplitPredictionCompleteSet { quantity: 5 }.data(),
            tidebook::accounts::PredictionCompleteSet {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
            }
            .to_account_metas(None),
        );
        assert!(send(&mut self.svm, &self.owner, &[init, deposit, split]).is_ok());
    }
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(tidebook::ID, PROGRAM).unwrap();
        let creator = Keypair::new();
        let owner = Keypair::new();
        for key in [creator.pubkey(), owner.pubkey()] {
            svm.airdrop(&key, 2_000_000_000).unwrap();
        }
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = 100;
        svm.set_sysvar(&clock);
        let (admin, bump) =
            Pubkey::find_program_address(&[b"admin", creator.pubkey().as_ref()], &tidebook::ID);
        let mut data = Vec::new();
        AdminRecord {
            authority: creator.pubkey(),
            added_by: creator.pubkey(),
            status: AdminStatus::Active,
            bump,
        }
        .try_serialize(&mut data)
        .unwrap();
        account(&mut svm, admin, data, tidebook::ID);
        let mint = Pubkey::new_unique();
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                decimals: 6,
                is_initialized: true,
                supply: 100_000_000,
                ..Mint::default()
            },
            &mut data,
        )
        .unwrap();
        account(&mut svm, mint, data, anchor_spl::token::ID);
        let source = Pubkey::new_unique();
        let mut data = vec![0; TokenAccount::LEN];
        TokenAccount::pack(
            TokenAccount {
                mint,
                owner: owner.pubkey(),
                amount: 100_000_000,
                state: AccountState::Initialized,
                ..TokenAccount::default()
            },
            &mut data,
        )
        .unwrap();
        account(&mut svm, source, data, anchor_spl::token::ID);
        let market = tidebook::derive_prediction_market_pda(&tidebook::ID, &[7; 32]).0;
        let book = tidebook::derive_prediction_book_pda(&tidebook::ID, &market).0;
        let position =
            tidebook::derive_prediction_position_pda(&tidebook::ID, &market, &owner.pubkey()).0;
        let authority =
            Pubkey::find_program_address(&[b"vault-authority", market.as_ref()], &tidebook::ID).0;
        let vault = Pubkey::find_program_address(
            &[b"vault", market.as_ref(), mint.as_ref()],
            &tidebook::ID,
        )
        .0;
        let fees = tidebook::derive_market_fees_pda(&tidebook::ID, &market).0;
        let init = Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::InitializePredictionMarket {
                market_id: [7; 32],
                config: PredictionMarketConfig {
                    resolver: creator.pubkey(),
                    fallback: None,
                    close_ts: 10000,
                    earliest_resolution_ts: None,
                    resolution_delay_seconds: 10,
                    payout_per_contract: 1_000_000,
                    price_tick: 10000,
                    rules_uri: "ar://fixture".into(),
                    question_hash: [1; 32],
                    rules_hash: [2; 32],
                },
                display_name: "Test question".into(),
                collateral_symbol: "tUSD".into(),
            }
            .data(),
            tidebook::accounts::InitializePredictionMarket {
                authority: creator.pubkey(),
                admin_record: admin,
                market,
                collateral_mint: mint,
                vault_authority: authority,
                collateral_vault: vault,
                market_metadata: tidebook::derive_market_metadata_pda(&tidebook::ID, &market).0,
                market_fees: fees,
                order_book: book,
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let open = Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::OpenPredictionMarket {}.data(),
            tidebook::accounts::OpenPredictionMarket {
                authority: creator.pubkey(),
                market,
                admin_record: admin,
            }
            .to_account_metas(None),
        );
        assert!(send(&mut svm, &creator, &[init, open]).is_ok());
        let init_position = Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::InitializePredictionPosition {}.data(),
            tidebook::accounts::InitializePredictionPosition {
                owner: owner.pubkey(),
                market,
                position,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let deposit = Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::DepositPredictionCollateral {
                amount: 100_000_000,
            }
            .data(),
            tidebook::accounts::DepositPredictionCollateral {
                owner: owner.pubkey(),
                market,
                position,
                collateral_mint: mint,
                source,
                vault_authority: authority,
                collateral_vault: vault,
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        );
        let split = Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::SplitPredictionCompleteSet { quantity: 10 }.data(),
            tidebook::accounts::PredictionCompleteSet {
                owner: owner.pubkey(),
                market,
                position,
            }
            .to_account_metas(None),
        );
        assert!(send(&mut svm, &owner, &[init_position, deposit, split]).is_ok());
        Self {
            svm,
            owner,
            market,
            book,
            position,
            vault,
            source,
            fees,
        }
    }
    fn ix(
        &self,
        outcome: PredictionOutcome,
        side: OrderSide,
        price: u64,
        quantity: u64,
        order_id: u64,
    ) -> Instruction {
        Instruction::new_with_bytes(
            tidebook::ID,
            &tidebook::instruction::PlacePredictionOrder {
                order_id,
                outcome,
                side,
                price,
                quantity,
            }
            .data(),
            tidebook::accounts::PlacePredictionOrder {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                order_book: self.book,
                price_level: tidebook::derive_prediction_price_level_pda(
                    &tidebook::ID,
                    &self.market,
                    outcome,
                    side,
                    price,
                )
                .0,
                order: tidebook::derive_prediction_order_pda(&tidebook::ID, &self.market, order_id)
                    .0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }
    fn snapshot(&self) -> Vec<Account> {
        [
            self.market,
            self.book,
            self.position,
            self.vault,
            self.source,
            self.fees,
        ]
        .iter()
        .map(|k| self.svm.get_account(k).unwrap())
        .collect()
    }
    fn reject(&mut self, ix: Instruction, code: &str) {
        let before = self.snapshot();
        let failure = send(&mut self.svm, &self.owner, std::slice::from_ref(&ix)).unwrap_err();
        assert!(
            failure
                .meta
                .logs
                .iter()
                .any(|line| line.contains(&format!("Error Code: {code}"))),
            "{failure:?}"
        );
        assert_eq!(self.snapshot(), before);
        for index in [4, 5] {
            assert!(self.svm.get_account(&ix.accounts[index].pubkey).is_none());
        }
    }
}

#[test]
fn a_non_admin_trader_can_seed_all_four_queues_without_moving_tokens_or_reserves() {
    let mut f = Fixture::new();
    assert!(f
        .svm
        .get_account(
            &Pubkey::find_program_address(&[b"admin", f.owner.pubkey().as_ref()], &tidebook::ID).0
        )
        .is_none());
    let vault = f.svm.get_account(&f.vault).unwrap();
    let fees = f.svm.get_account(&f.fees).unwrap();
    for (index, (outcome, side, price)) in [
        (PredictionOutcome::Yes, OrderSide::Bid, 600000),
        (PredictionOutcome::Yes, OrderSide::Ask, 700000),
        (PredictionOutcome::No, OrderSide::Bid, 300000),
        (PredictionOutcome::No, OrderSide::Ask, 400000),
    ]
    .into_iter()
    .enumerate()
    {
        let id = index as u64 + 1;
        let ix = f.ix(outcome, side, price, 2, id);
        let result = send(&mut f.svm, &f.owner, std::slice::from_ref(&ix));
        assert!(result.is_ok(), "{result:?}");
        let order: PredictionOrder = read(&f.svm, ix.accounts[5].pubkey);
        let level: PredictionPriceLevel = read(&f.svm, ix.accounts[4].pubkey);
        assert_eq!(
            (
                order.owner,
                order.market,
                order.order_id,
                order.outcome,
                order.side,
                order.price
            ),
            (f.owner.pubkey(), f.market, id, outcome, side, price)
        );
        assert_eq!(
            (
                order.quantity,
                order.remaining_quantity,
                order.locked_collateral,
                order.status
            ),
            (
                2,
                2,
                if side == OrderSide::Bid { price * 2 } else { 2 },
                OrderStatus::Open
            )
        );
        assert_eq!((order.previous_order, order.next_order), (None, None));
        assert_eq!(
            (level.market, level.outcome, level.side, level.price),
            (f.market, outcome, side, price)
        );
        assert_eq!(
            (
                level.first_order,
                level.last_order,
                level.better_price,
                level.worse_price
            ),
            (
                Some(ix.accounts[5].pubkey),
                Some(ix.accounts[5].pubkey),
                None,
                None
            )
        );
        assert_eq!(
            (
                level.total_remaining_quantity,
                level.order_count,
                level.rent_payer
            ),
            (2, 1, f.owner.pubkey())
        );
        assert_eq!(order.price_level, ix.accounts[4].pubkey);
        assert_eq!(
            f.svm
                .get_account(&ix.accounts[4].pubkey)
                .unwrap()
                .data
                .len(),
            183
        );
        assert_eq!(
            f.svm
                .get_account(&ix.accounts[5].pubkey)
                .unwrap()
                .data
                .len(),
            214
        );
    }
    let book: PredictionOrderBook = read(&f.svm, f.book);
    assert_eq!(
        [
            book.yes_best_bid,
            book.yes_best_ask,
            book.no_best_bid,
            book.no_best_ask
        ],
        [Some(600000), Some(700000), Some(300000), Some(400000)]
    );
    assert_eq!(book.next_order_id, 5);
    let p: PredictionPosition = read(&f.svm, f.position);
    assert_eq!(
        (
            p.collateral_free,
            p.collateral_locked,
            p.yes_free,
            p.yes_locked,
            p.no_free,
            p.no_locked
        ),
        (88_200_000, 1_800_000, 8, 2, 8, 2)
    );
    let m: PredictionMarket = read(&f.svm, f.market);
    assert_eq!(
        (
            m.open_order_count,
            m.yes_supply,
            m.no_supply,
            m.backing_reserve
        ),
        (4, 10, 10, 10_000_000)
    );
    assert_eq!(f.svm.get_account(&f.vault).unwrap(), vault);
    assert_eq!(f.svm.get_account(&f.fees).unwrap(), fees);
    assert_eq!(
        p.collateral_free + p.collateral_locked + m.backing_reserve,
        100_000_000
    );
}

#[test]
fn zero_bad_prices_stale_ids_and_insufficient_funding_roll_back_allocations() {
    let mut f = Fixture::new();
    for (price, qty, id, code) in [
        (600000, 0, 1, "InvalidPredictionContractQuantity"),
        (0, 1, 1, "InvalidPredictionOrderPrice"),
        (1000000, 1, 1, "InvalidPredictionOrderPrice"),
        (600001, 1, 1, "InvalidPredictionOrderPrice"),
        (600000, 1, 0, "InvalidPredictionOrderId"),
        (600000, 1, 2, "InvalidPredictionOrderId"),
        (600000, 151, 1, "InsufficientFreeBalance"),
        (600000, u64::MAX, 1, "PredictionAccountingOverflow"),
    ] {
        let ix = f.ix(PredictionOutcome::Yes, OrderSide::Bid, price, qty, id);
        f.reject(ix, code);
    }
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        let ix = f.ix(outcome, OrderSide::Ask, 600000, 11, 1);
        f.reject(ix, "InsufficientPredictionPositions");
    }
}

#[test]
fn lifecycle_and_the_exact_close_boundary_are_enforced() {
    let mut f = Fixture::new();
    for status in [
        PredictionStatus::Draft,
        PredictionStatus::Frozen,
        PredictionStatus::Proposed,
        PredictionStatus::Resolved,
    ] {
        let mut m: PredictionMarket = read(&f.svm, f.market);
        m.status = status;
        write(&mut f.svm, f.market, &m);
        let ix = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
        f.reject(ix, "PredictionOrderUnavailable");
    }
    let mut m: PredictionMarket = read(&f.svm, f.market);
    m.status = PredictionStatus::Open;
    write(&mut f.svm, f.market, &m);
    for now in [10000, 10001] {
        let mut clock = f.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = now;
        f.svm.set_sysvar(&clock);
        let ix = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
        f.reject(ix, "PredictionOrderUnavailable");
    }
    let mut clock = f.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 9999;
    f.svm.set_sysvar(&clock);
    let ix = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
    assert!(send(&mut f.svm, &f.owner, &[ix]).is_ok());
}

#[test]
fn existing_sides_and_crossing_prices_are_rejected_without_detaching_queues() {
    let mut f = Fixture::new();
    let first = f.ix(PredictionOutcome::Yes, OrderSide::Ask, 700000, 2, 1);
    assert!(send(&mut f.svm, &f.owner, &[first]).is_ok());
    let ix = f.ix(PredictionOutcome::Yes, OrderSide::Ask, 800000, 1, 2);
    f.reject(ix, "PredictionSideNotEmpty");
    for price in [700000, 710000] {
        let ix = f.ix(PredictionOutcome::Yes, OrderSide::Bid, price, 1, 2);
        f.reject(ix, "PredictionOrderWouldCross");
    }
    let mut f = Fixture::new();
    let first = f.ix(PredictionOutcome::No, OrderSide::Bid, 600000, 2, 1);
    assert!(send(&mut f.svm, &f.owner, &[first]).is_ok());
    for price in [600000, 590000] {
        let ix = f.ix(PredictionOutcome::No, OrderSide::Ask, price, 1, 2);
        f.reject(ix, "PredictionOrderWouldCross");
    }
}

#[test]
fn counter_and_locked_bucket_overflow_cannot_partially_lock_assets() {
    for case in 0..6 {
        let mut f = Fixture::new();
        let mut id = 1;
        let mut side = OrderSide::Bid;
        match case {
            0 => {
                let mut b: PredictionOrderBook = read(&f.svm, f.book);
                b.next_order_id = u64::MAX;
                id = u64::MAX;
                write(&mut f.svm, f.book, &b);
            }
            1 => {
                let mut m: PredictionMarket = read(&f.svm, f.market);
                m.open_order_count = u64::MAX;
                write(&mut f.svm, f.market, &m);
            }
            2 => {
                let mut p: PredictionPosition = read(&f.svm, f.position);
                p.collateral_locked = u64::MAX;
                write(&mut f.svm, f.position, &p);
            }
            3 => {
                side = OrderSide::Ask;
                let mut p: PredictionPosition = read(&f.svm, f.position);
                p.yes_locked = u64::MAX;
                write(&mut f.svm, f.position, &p);
            }
            4 => {
                let mut m: PredictionMarket = read(&f.svm, f.market);
                m.price_tick = 0;
                write(&mut f.svm, f.market, &m);
            }
            _ => {
                side = OrderSide::Ask;
                let mut p: PredictionPosition = read(&f.svm, f.position);
                p.no_locked = u64::MAX;
                write(&mut f.svm, f.position, &p);
            }
        }
        let outcome = if case == 5 {
            PredictionOutcome::No
        } else {
            PredictionOutcome::Yes
        };
        let ix = f.ix(outcome, side, 600000, 1, id);
        f.reject(
            ix,
            match case {
                0 | 1 => "PredictionAccountingOverflow",
                4 => "InvalidPredictionOrderPrice",
                _ => "LockedBalanceOverflow",
            },
        );
    }
}

#[test]
fn canonical_addresses_stored_ownership_and_signatures_are_required() {
    for index in 1..6 {
        let mut f = Fixture::new();
        let mut ix = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
        let replacement = Pubkey::new_unique();
        if let Some(existing) = f.svm.get_account(&ix.accounts[index].pubkey) {
            f.svm.set_account(replacement, existing).unwrap();
        }
        ix.accounts[index].pubkey = replacement;
        f.reject(ix, "ConstraintSeeds");
    }
    for case in 0..3 {
        let mut f = Fixture::new();
        if case < 2 {
            let mut p: PredictionPosition = read(&f.svm, f.position);
            if case == 0 {
                p.owner = Pubkey::new_unique();
            } else {
                p.market = Pubkey::new_unique();
            }
            write(&mut f.svm, f.position, &p);
        } else {
            let mut b: PredictionOrderBook = read(&f.svm, f.book);
            b.market = Pubkey::new_unique();
            write(&mut f.svm, f.book, &b);
        }
        let ix = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
        f.reject(
            ix,
            match case {
                0 => "PredictionPositionOwnerMismatch",
                1 => "PredictionPositionMarketMismatch",
                _ => "PredictionBookMarketMismatch",
            },
        );
    }
    let mut f = Fixture::new();
    let mut ix = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
    ix.accounts[0].pubkey = f.source;
    ix.accounts[0].is_signer = false;
    f.reject(ix, "AccountNotSigner");
}

#[test]
fn a_later_failed_order_rolls_back_the_first_order_and_both_claim_changes() {
    let mut f = Fixture::new();
    let before = f.snapshot();
    let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
    let bad = f.ix(PredictionOutcome::No, OrderSide::Ask, 400000, 11, 2);
    let failure = send(&mut f.svm, &f.owner, &[first.clone(), bad.clone()]).unwrap_err();
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains("InsufficientPredictionPositions")),
        "{failure:?}"
    );
    assert_eq!(f.snapshot(), before);
    for ix in [first, bad] {
        for index in [4, 5] {
            assert!(f.svm.get_account(&ix.accounts[index].pubkey).is_none());
        }
    }
}

#[test]
fn an_existing_order_id_cannot_be_overwritten_or_reused_on_another_outcome() {
    let mut f = Fixture::new();
    let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
    assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&first)).is_ok());
    let before = f.snapshot();
    let order = f.svm.get_account(&first.accounts[5].pubkey).unwrap();
    let level = f.svm.get_account(&first.accounts[4].pubkey).unwrap();
    let retry = f.ix(PredictionOutcome::No, OrderSide::Bid, 300000, 2, 1);
    assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&retry)).is_err());
    assert_eq!(f.snapshot(), before);
    assert_eq!(f.svm.get_account(&first.accounts[5].pubkey).unwrap(), order);
    assert_eq!(f.svm.get_account(&first.accounts[4].pubkey).unwrap(), level);
    assert!(f.svm.get_account(&retry.accounts[4].pubkey).is_none());
}

#[test]
fn different_traders_append_three_fifo_orders_on_every_outcome_and_side() {
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for side in [OrderSide::Bid, OrderSide::Ask] {
            let mut f = Fixture::new();
            let first = f.ix(outcome, side, 600000, 2, 1);
            assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&first)).is_ok());
            let alice_position = f.position;
            let alice_before = f.svm.get_account(&alice_position).unwrap();
            let mut expected_first: PredictionOrder = read(&f.svm, first.accounts[5].pubkey);
            let first_owner = expected_first.owner;
            let rent_payer: PredictionPriceLevel = read(&f.svm, first.accounts[4].pubkey);
            f.switch_to_funded_trader();
            assert_ne!(first_owner, f.owner.pubkey());
            let vault = f.svm.get_account(&f.vault).unwrap();
            let fees = f.svm.get_account(&f.fees).unwrap();
            let second = f.append(outcome, side, 600000, 2, 2, first.accounts[5].pubkey);
            assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&second)).is_ok());
            let third = f.append(outcome, side, 600000, 1, 3, second.accounts[6].pubkey);
            assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&third)).is_ok());
            expected_first.next_order = Some(second.accounts[6].pubkey);
            let mut expected = Vec::new();
            expected_first.try_serialize(&mut expected).unwrap();
            expected.resize(214, 0);
            assert_eq!(
                f.svm.get_account(&first.accounts[5].pubkey).unwrap().data,
                expected
            );
            let second_order: PredictionOrder = read(&f.svm, second.accounts[6].pubkey);
            let third_order: PredictionOrder = read(&f.svm, third.accounts[6].pubkey);
            assert_eq!(
                (second_order.previous_order, second_order.next_order),
                (
                    Some(first.accounts[5].pubkey),
                    Some(third.accounts[6].pubkey)
                )
            );
            assert_eq!(
                (third_order.previous_order, third_order.next_order),
                (Some(second.accounts[6].pubkey), None)
            );
            for order in [&second_order, &third_order] {
                assert_eq!(
                    (
                        order.owner,
                        order.outcome,
                        order.side,
                        order.price,
                        order.status
                    ),
                    (f.owner.pubkey(), outcome, side, 600000, OrderStatus::Open)
                );
            }
            let level: PredictionPriceLevel = read(&f.svm, first.accounts[4].pubkey);
            assert_eq!(
                (
                    level.first_order,
                    level.last_order,
                    level.order_count,
                    level.total_remaining_quantity
                ),
                (
                    Some(first.accounts[5].pubkey),
                    Some(third.accounts[6].pubkey),
                    3,
                    5
                )
            );
            assert_eq!(
                (level.better_price, level.worse_price, level.rent_payer),
                (None, None, rent_payer.rent_payer)
            );
            let book: PredictionOrderBook = read(&f.svm, f.book);
            assert_eq!(book.next_order_id, 4);
            assert_eq!(book.best_price(outcome, side), Some(600000));
            assert_eq!(f.svm.get_account(&alice_position).unwrap(), alice_before);
            assert_eq!(f.svm.get_account(&f.vault).unwrap(), vault);
            assert_eq!(f.svm.get_account(&f.fees).unwrap(), fees);
            let alice: PredictionPosition = read(&f.svm, alice_position);
            let bob: PredictionPosition = read(&f.svm, f.position);
            let market: PredictionMarket = read(&f.svm, f.market);
            assert_eq!(market.open_order_count, 3);
            assert_eq!(market.backing_reserve, 15_000_000);
            assert_eq!(
                alice.collateral_free
                    + alice.collateral_locked
                    + bob.collateral_free
                    + bob.collateral_locked
                    + market.backing_reserve,
                120_000_000
            );
            assert_eq!(
                alice.yes_free + alice.yes_locked + bob.yes_free + bob.yes_locked,
                market.yes_supply
            );
            assert_eq!(
                alice.no_free + alice.no_locked + bob.no_free + bob.no_locked,
                market.no_supply
            );
        }
    }
}

#[test]
fn stale_or_substituted_tails_and_corrupt_tail_fields_are_rejected() {
    let mut f = Fixture::new();
    let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 2, 1);
    assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&first)).is_ok());
    let second = f.append(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        600000,
        1,
        2,
        first.accounts[5].pubkey,
    );
    assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&second)).is_ok());
    let stale = f.append(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        600000,
        1,
        3,
        first.accounts[5].pubkey,
    );
    f.reject_append(stale, "InvalidPredictionTail");
    for case in 0..9 {
        let mut f = Fixture::new();
        let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 2, 1);
        assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&first)).is_ok());
        let mut tail: PredictionOrder = read(&f.svm, first.accounts[5].pubkey);
        match case {
            0 => tail.market = Pubkey::new_unique(),
            1 => tail.price_level = Pubkey::new_unique(),
            2 => tail.outcome = PredictionOutcome::No,
            3 => tail.side = OrderSide::Ask,
            4 => tail.price = 610000,
            5 => tail.status = OrderStatus::Filled,
            6 => tail.remaining_quantity = 0,
            7 => tail.next_order = Some(Pubkey::new_unique()),
            _ => tail.previous_order = Some(Pubkey::new_unique()),
        }
        write(&mut f.svm, first.accounts[5].pubkey, &tail);
        let ix = f.append(
            PredictionOutcome::Yes,
            OrderSide::Bid,
            600000,
            1,
            2,
            first.accounts[5].pubkey,
        );
        f.reject_append(ix, "InvalidPredictionTail");
    }
}

#[test]
fn append_binds_canonical_level_tail_book_and_position_accounts() {
    for index in 1..7 {
        let mut f = Fixture::new();
        let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 2, 1);
        assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&first)).is_ok());
        let mut ix = f.append(
            PredictionOutcome::Yes,
            OrderSide::Bid,
            600000,
            1,
            2,
            first.accounts[5].pubkey,
        );
        let replacement = Pubkey::new_unique();
        if let Some(existing) = f.svm.get_account(&ix.accounts[index].pubkey) {
            f.svm.set_account(replacement, existing).unwrap();
        }
        ix.accounts[index].pubkey = replacement;
        f.reject_append(ix, "ConstraintSeeds");
    }
    for case in 0..8 {
        let mut f = Fixture::new();
        let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 2, 1);
        assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&first)).is_ok());
        let mut level: PredictionPriceLevel = read(&f.svm, first.accounts[4].pubkey);
        match case {
            0 => level.market = Pubkey::new_unique(),
            1 => level.outcome = PredictionOutcome::No,
            2 => level.side = OrderSide::Ask,
            3 => level.price = 610000,
            4 => level.first_order = None,
            5 => level.last_order = None,
            6 => level.order_count = 0,
            _ => level.total_remaining_quantity = 1,
        }
        write(&mut f.svm, first.accounts[4].pubkey, &level);
        let ix = f.append(
            PredictionOutcome::Yes,
            OrderSide::Bid,
            600000,
            1,
            2,
            first.accounts[5].pubkey,
        );
        f.reject_append(
            ix,
            if case < 4 {
                "InvalidPredictionPriceLevel"
            } else {
                "InvalidPredictionTail"
            },
        );
    }
}

#[test]
fn append_rejects_closed_zero_stale_underfunded_and_overflowing_requests() {
    for side in [OrderSide::Bid, OrderSide::Ask] {
        let mut f = Fixture::new();
        let first = f.ix(PredictionOutcome::Yes, side, 600000, 2, 1);
        assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&first)).is_ok());
        for (qty, id, code) in [
            (0, 2, "InvalidPredictionContractQuantity"),
            (1, 3, "InvalidPredictionOrderId"),
            (
                151,
                2,
                if side == OrderSide::Bid {
                    "InsufficientFreeBalance"
                } else {
                    "InsufficientPredictionPositions"
                },
            ),
        ] {
            let ix = f.append(
                PredictionOutcome::Yes,
                side,
                600000,
                qty,
                id,
                first.accounts[5].pubkey,
            );
            f.reject_append(ix, code);
        }
        for status in [
            PredictionStatus::Draft,
            PredictionStatus::Frozen,
            PredictionStatus::Proposed,
            PredictionStatus::Resolved,
        ] {
            let mut m: PredictionMarket = read(&f.svm, f.market);
            m.status = status;
            write(&mut f.svm, f.market, &m);
            let ix = f.append(
                PredictionOutcome::Yes,
                side,
                600000,
                1,
                2,
                first.accounts[5].pubkey,
            );
            f.reject_append(ix, "PredictionOrderUnavailable");
        }
        let mut m: PredictionMarket = read(&f.svm, f.market);
        m.status = PredictionStatus::Open;
        write(&mut f.svm, f.market, &m);
        let mut clock = f.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = 10000;
        f.svm.set_sysvar(&clock);
        let ix = f.append(
            PredictionOutcome::Yes,
            side,
            600000,
            1,
            2,
            first.accounts[5].pubkey,
        );
        f.reject_append(ix, "PredictionOrderUnavailable");
    }
    for case in 0..5 {
        let mut f = Fixture::new();
        let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 2, 1);
        assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&first)).is_ok());
        let second = f.append(
            PredictionOutcome::Yes,
            OrderSide::Bid,
            600000,
            1,
            2,
            first.accounts[5].pubkey,
        );
        assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&second)).is_ok());
        let mut id = 3;
        match case {
            0 => {
                let mut b: PredictionOrderBook = read(&f.svm, f.book);
                b.next_order_id = u64::MAX;
                id = u64::MAX;
                write(&mut f.svm, f.book, &b);
            }
            1 => {
                let mut m: PredictionMarket = read(&f.svm, f.market);
                m.open_order_count = u64::MAX;
                write(&mut f.svm, f.market, &m);
            }
            2 | 3 => {
                let mut l: PredictionPriceLevel = read(&f.svm, first.accounts[4].pubkey);
                if case == 2 {
                    l.total_remaining_quantity = u64::MAX;
                } else {
                    l.order_count = u64::MAX;
                }
                write(&mut f.svm, first.accounts[4].pubkey, &l);
            }
            _ => {
                let mut p: PredictionPosition = read(&f.svm, f.position);
                p.collateral_locked = u64::MAX;
                write(&mut f.svm, f.position, &p);
            }
        }
        let ix = f.append(
            PredictionOutcome::Yes,
            OrderSide::Bid,
            600000,
            1,
            id,
            second.accounts[6].pubkey,
        );
        f.reject_append(
            ix,
            if case == 4 {
                "LockedBalanceOverflow"
            } else {
                "PredictionAccountingOverflow"
            },
        );
    }
}

#[test]
fn failed_append_batch_restores_original_tail_and_all_ledger_totals() {
    let mut f = Fixture::new();
    let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 2, 1);
    assert!(send(&mut f.svm, &f.owner, std::slice::from_ref(&first)).is_ok());
    let before = f.snapshot();
    let tail = f.svm.get_account(&first.accounts[5].pubkey).unwrap();
    let level = f.svm.get_account(&first.accounts[4].pubkey).unwrap();
    let second = f.append(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        600000,
        1,
        2,
        first.accounts[5].pubkey,
    );
    let bad = f.append(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        600000,
        1000,
        3,
        second.accounts[6].pubkey,
    );
    let failure = send(&mut f.svm, &f.owner, &[second.clone(), bad.clone()]).unwrap_err();
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|line| line.contains("InsufficientFreeBalance")),
        "{failure:?}"
    );
    assert_eq!(f.snapshot(), before);
    assert_eq!(f.svm.get_account(&first.accounts[5].pubkey).unwrap(), tail);
    assert_eq!(f.svm.get_account(&first.accounts[4].pubkey).unwrap(), level);
    for ix in [second, bad] {
        assert!(f.svm.get_account(&ix.accounts[6].pubkey).is_none());
    }
}

#[test]
fn append_rejects_other_outcome_tails_unsigned_callers_and_crossed_snapshots() {
    let mut f = Fixture::new();
    let yes = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 2, 1);
    let no = f.ix(PredictionOutcome::No, OrderSide::Bid, 300000, 2, 2);
    assert!(send(&mut f.svm, &f.owner, &[yes.clone(), no.clone()]).is_ok());
    let wrong = f.append(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        600000,
        1,
        3,
        no.accounts[5].pubkey,
    );
    f.reject_append(wrong, "InvalidPredictionTail");
    let mut unsigned = f.append(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        600000,
        1,
        3,
        yes.accounts[5].pubkey,
    );
    unsigned.accounts[0].pubkey = f.source;
    unsigned.accounts[0].is_signer = false;
    f.reject_append(unsigned, "AccountNotSigner");
    // A malformed crossed snapshot must not bypass the resting-only rule,
    // including when appending at a price that was valid when first submitted.
    let mut book: PredictionOrderBook = read(&f.svm, f.book);
    book.yes_best_ask = Some(600000);
    write(&mut f.svm, f.book, &book);
    let ix = f.append(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        600000,
        1,
        3,
        yes.accounts[5].pubkey,
    );
    f.reject_append(ix, "PredictionOrderWouldCross");
}
