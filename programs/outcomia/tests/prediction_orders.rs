//! Resting orders, cancellation and one-maker prediction settlement in LiteSVM.
//!
//! Draft/open/deposit/split use real instructions before trading tests. Direct
//! host account writes are limited to fixture setup, faucet grants and explicit
//! adversarial/corruption cases; they do not prove those states are reachable
//! through production instructions. Ordinary traders have no admin record.
//! Failure snapshots exclude payer SOL because rejected transactions still pay
//! fees; rent-refund tests separately inspect the affected wallet lamports.
#![allow(clippy::result_large_err)]
use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenAccount, AccountState, Mint};
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

/// Submits a signed instruction batch to the isolated VM.
///
/// # Inputs
/// Mutable LiteSVM, one signer/fee payer and ordered instructions.
///
/// # Errors
/// Returns LiteSVM failure metadata for program rejection; transaction-signing fixture failures
/// panic.
///
/// # Returns
/// TransactionResult after expiring the previous blockhash; it preserves logs for expected-error
/// assertions.
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
/// Installs serialized host fixture state directly.
///
/// # Inputs
/// Mutable VM, address, data bytes and owning program key.
///
/// # Errors
/// Panics if LiteSVM rejects the fixture account; no production instruction validates these
/// injected bytes.
///
/// # Returns
/// A rent-funded account at the supplied address; this is setup/corruption support, not a simulated
/// deposit.
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
/// Loads one expected fixture account as an Anchor type.
///
/// # Inputs
/// Borrowed VM, account address and generic deserialization type.
///
/// # Errors
/// Panics on missing/wrong/malformed account; absence is a test failure here.
///
/// # Returns
/// The deserialized value for assertions; the stored account is unchanged.
fn read<T: AccountDeserialize>(svm: &LiteSVM, key: Pubkey) -> T {
    T::try_deserialize(&mut svm.get_account(&key).unwrap().data.as_slice()).unwrap()
}
/// Replaces fixture data while preserving its allocated length.
///
/// # Inputs
/// Mutable VM, existing key and Anchor-serializable state expected to fit the allocation.
///
/// # Errors
/// Panics on missing account, serialization or VM replacement failure; production authorization is
/// bypassed deliberately.
///
/// # Returns
/// Updated fixture bytes padded to the old length, retaining lamports/owner; only adversarial/setup
/// cases use this path.
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
    /// Injects protocol configuration for fee-boundary tests.
    ///
    /// # Inputs
    /// Mutable fixture and u16 rate, including invalid rates used to test matching's defensive
    /// checks.
    ///
    /// # Errors
    /// Panics on fixture serialization/install failure; this bypasses the governed setter
    /// intentionally.
    ///
    /// # Returns
    /// A canonical config account with the selected rate; it does not prove governance would accept
    /// that rate.
    fn set_fee_rate(&mut self, rate: u16) {
        let (key, bump) =
            Pubkey::find_program_address(&[outcomia::PROTOCOL_CONFIG_SEED], &outcomia::ID);
        let mut data = Vec::new();
        ProtocolConfig {
            super_admin: self.owner.pubkey(),
            taker_fee_bps: rate,
            bump,
        }
        .try_serialize(&mut data)
        .unwrap();
        account(&mut self.svm, key, data, outcomia::ID);
    }

    /// Builds one matching instruction from the VM's current maker state.
    ///
    /// # Inputs
    /// Fixture's current taker, maker ID, outcome/side, raw limit and whole quantity.
    ///
    /// # Errors
    /// Panics if expected maker/level accounts are missing; building does not execute or authorize
    /// the trade.
    ///
    /// # Returns
    /// An Instruction with successor/worse/rent hints only when this request would remove them.
    fn match_ix(
        &self,
        id: u64,
        outcome: PredictionOutcome,
        taker_side: OrderSide,
        limit_price: u64,
        quantity: u64,
    ) -> Instruction {
        let maker: PredictionOrder = read(&self.svm, self.order_key(id));
        let level: PredictionPriceLevel = read(&self.svm, maker.price_level);
        let full = quantity >= maker.remaining_quantity;
        let closes = full && level.order_count == 1;
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::MatchPredictionOrder {
                outcome,
                taker_side,
                limit_price,
                quantity,
            }
            .data(),
            outcomia::accounts::MatchPredictionOrder {
                taker: self.owner.pubkey(),
                market: self.market,
                order_book: self.book,
                protocol_config: Pubkey::find_program_address(
                    &[outcomia::PROTOCOL_CONFIG_SEED],
                    &outcomia::ID,
                )
                .0,
                market_fees: self.fees,
                maker_order: self.order_key(id),
                price_level: maker.price_level,
                maker_position: outcomia::derive_prediction_position_pda(
                    &outcomia::ID,
                    &self.market,
                    &maker.owner,
                )
                .0,
                taker_position: self.position,
                next_order: if full && !closes {
                    maker.next_order
                } else {
                    None
                },
                worse_level: if closes {
                    level
                        .worse_price
                        .map(|p| self.level(outcome, maker.side, p))
                } else {
                    None
                },
                level_rent_recipient: closes.then_some(level.rent_payer),
            }
            .to_account_metas(None),
        )
    }

    /// Asserts a rejected match leaves claims and supplied state unchanged.
    ///
    /// # Inputs
    /// Mutable fixture, candidate instruction and expected Anchor error-code name.
    ///
    /// # Errors
    /// Panics if execution succeeds, reports another error or any snapshotted account changes.
    ///
    /// # Returns
    /// Unit after checking rollback, including maker/taker ledgers, fees and supplied hints; payer
    /// transaction fees are excluded.
    fn reject_match(&mut self, ix: Instruction, code: &str) {
        let before = self.snapshot();
        let keys: Vec<_> = ix
            .accounts
            .iter()
            .map(|a| a.pubkey)
            .filter(|k| *k != self.owner.pubkey())
            .collect();
        let stored: Vec<_> = keys.iter().map(|key| self.svm.get_account(key)).collect();
        let failure = send(&mut self.svm, &self.owner, &[ix]).unwrap_err();
        assert!(
            failure
                .meta
                .logs
                .iter()
                .any(|s| s.contains(&format!("Error Code: {code}"))),
            "{failure:?}"
        );
        assert_eq!(self.snapshot(), before);
        for (key, old) in keys.iter().zip(stored) {
            assert_eq!(self.svm.get_account(key), old);
        }
    }

    /// Sum both traders' cash/outcome claims plus reserve/fees against custody.
    ///
    /// # Inputs
    /// Fixture holding current taker position plus the other maker position address.
    ///
    /// # Errors
    /// Panics on missing accounts or unequal cash/contract totals; assumes these are all traders
    /// whose claims the fixture funded.
    ///
    /// # Returns
    /// Unit after proving vault = both cash claims + reserve + fees, and each outcome's free/locked
    /// claims equal its supply.
    fn assert_trade_conservation(&self, maker_position: Pubkey) {
        let maker: PredictionPosition = read(&self.svm, maker_position);
        let taker: PredictionPosition = read(&self.svm, self.position);
        let market: PredictionMarket = read(&self.svm, self.market);
        let fees: MarketFees = read(&self.svm, self.fees);
        let vault = TokenAccount::unpack(&self.svm.get_account(&self.vault).unwrap().data).unwrap();
        assert_eq!(
            vault.amount,
            maker.collateral_free
                + maker.collateral_locked
                + taker.collateral_free
                + taker.collateral_locked
                + market.backing_reserve
                + fees.accrued_quote_fees
        );
        assert_eq!(
            market.yes_supply,
            maker.yes_free + maker.yes_locked + taker.yes_free + taker.yes_locked
        );
        assert_eq!(
            market.no_supply,
            maker.no_free + maker.no_locked + taker.no_free + taker.no_locked
        );
    }
    /// Derives a fixture prediction order address.
    ///
    /// # Inputs
    /// Fixture market and market-wide numeric ID.
    ///
    /// # Errors
    /// None; this does not check whether the account exists.
    ///
    /// # Returns
    /// Canonical order Pubkey for the Outcomia test program.
    fn order_key(&self, id: u64) -> Pubkey {
        outcomia::derive_prediction_order_pda(&outcomia::ID, &self.market, id).0
    }

    /// Discover exactly the stored immediate hints, as a real client must do.
    ///
    /// # Inputs
    /// Fixture's current signer/position and order ID; target order and level must exist.
    ///
    /// # Errors
    /// Panics when expected fixture accounts are absent; authorization/link errors remain for
    /// program execution.
    ///
    /// # Returns
    /// An Instruction with price/rent hints only for final-order removal.
    fn cancel(&self, id: u64) -> Instruction {
        let order: PredictionOrder = read(&self.svm, self.order_key(id));
        let level: PredictionPriceLevel = read(&self.svm, order.price_level);
        let closes = level.order_count == 1;
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::CancelPredictionOrder { order_id: id }.data(),
            outcomia::accounts::CancelPredictionOrder {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                order_book: self.book,
                order: self.order_key(id),
                price_level: order.price_level,
                previous_order: order.previous_order,
                next_order: order.next_order,
                better_level: if closes {
                    level
                        .better_price
                        .map(|p| self.level(order.outcome, order.side, p))
                } else {
                    None
                },
                worse_level: if closes {
                    level
                        .worse_price
                        .map(|p| self.level(order.outcome, order.side, p))
                } else {
                    None
                },
                level_rent_recipient: closes.then_some(level.rent_payer),
            }
            .to_account_metas(None),
        )
    }

    /// Checks cancellation rejection and complete account rollback.
    ///
    /// # Inputs
    /// Mutable fixture, candidate cancellation and expected error-code name.
    ///
    /// # Errors
    /// Panics if execution succeeds, the code differs or state changes.
    ///
    /// # Returns
    /// Unit after comparing custody/book/ledger and supplied accounts, excluding the fee-paying
    /// wallet's SOL.
    fn reject_cancel(&mut self, ix: Instruction, code: &str) {
        let before = self.snapshot();
        let keys: Vec<_> = ix
            .accounts
            .iter()
            .map(|a| a.pubkey)
            .filter(|k| *k != self.owner.pubkey())
            .collect();
        let stored: Vec<_> = keys.iter().map(|k| self.svm.get_account(k)).collect();
        let failure = send(&mut self.svm, &self.owner, &[ix]).unwrap_err();
        assert!(
            failure
                .meta
                .logs
                .iter()
                .any(|s| s.contains(&format!("Error Code: {code}"))),
            "{failure:?}"
        );
        assert_eq!(self.snapshot(), before);
        for (key, old) in keys.iter().zip(stored) {
            assert_eq!(self.svm.get_account(key), old);
        }
    }

    /// Creates a real resting FIFO queue before the scenario under test.
    ///
    /// # Inputs
    /// Mutable fixture, outcome, side and queue size; uses two contracts per order at raw price
    /// 600,000.
    ///
    /// # Errors
    /// Panics if placement/append setup fails; the helper expects fresh IDs beginning at 1.
    ///
    /// # Returns
    /// A funded queue made through production instructions, not injected linked-list accounts.
    fn seed_queue(&mut self, outcome: PredictionOutcome, side: OrderSide, size: u64) {
        let first = self.ix(outcome, side, 600000, 2, 1);
        send(&mut self.svm, &self.owner, &[first]).unwrap();
        for id in 2..=size {
            let ix = self.append(outcome, side, 600000, 2, id, self.order_key(id - 1));
            send(&mut self.svm, &self.owner, &[ix]).unwrap();
        }
    }
    /// Derives a fixture prediction price-level address.
    ///
    /// # Inputs
    /// Fixture market, outcome, side and raw u64 price.
    ///
    /// # Errors
    /// None; no account-existence check occurs.
    ///
    /// # Returns
    /// Canonical level Pubkey with the prediction namespace.
    fn level(&self, outcome: PredictionOutcome, side: OrderSide, price: u64) -> Pubkey {
        outcomia::derive_prediction_price_level_pda(
            &outcomia::ID,
            &self.market,
            outcome,
            side,
            price,
        )
        .0
    }
    /// Builds sorted insertion using explicit adjacent-price hints.
    ///
    /// # Inputs
    /// Fixture current owner/position, outcome/side/price/quantity and optional better/worse
    /// prices; reads the current next ID.
    ///
    /// # Errors
    /// Panics if the book fixture is absent; incorrect hints are preserved for rejection tests.
    ///
    /// # Returns
    /// An insertion Instruction; it does not lock funds until the VM executes it.
    fn insert(
        &self,
        outcome: PredictionOutcome,
        side: OrderSide,
        price: u64,
        quantity: u64,
        neighbors: (Option<u64>, Option<u64>),
    ) -> Instruction {
        let book: PredictionOrderBook = read(&self.svm, self.book);
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InsertPredictionOrder {
                order_id: book.next_order_id,
                outcome,
                side,
                price,
                quantity,
            }
            .data(),
            outcomia::accounts::InsertPredictionOrder {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                order_book: self.book,
                price_level: self.level(outcome, side, price),
                order: outcomia::derive_prediction_order_pda(
                    &outcomia::ID,
                    &self.market,
                    book.next_order_id,
                )
                .0,
                system_program: system_program::ID,
                better_level: neighbors.0.map(|p| self.level(outcome, side, p)),
                worse_level: neighbors.1.map(|p| self.level(outcome, side, p)),
            }
            .to_account_metas(None),
        )
    }

    /// Compare all supplied state accounts as well as custody/ledger snapshots.
    /// Payer SOL is excluded because failed transactions still charge fees.
    ///
    /// # Inputs
    /// Mutable fixture, instruction and expected Anchor error code.
    ///
    /// # Errors
    /// Panics on unexpected success/error or changed snapshotted accounts.
    ///
    /// # Returns
    /// Unit after rollback assertions for market, ledger, custody, neighbors and attempted
    /// order/level allocations.
    fn reject_insert(&mut self, ix: Instruction, code: &str) {
        let before = self.snapshot();
        let keys: Vec<_> = ix.accounts.iter().skip(1).map(|a| a.pubkey).collect();
        let stored: Vec<_> = keys.iter().map(|k| self.svm.get_account(k)).collect();
        let failure = send(&mut self.svm, &self.owner, &[ix]).unwrap_err();
        assert!(
            failure
                .meta
                .logs
                .iter()
                .any(|s| s.contains(&format!("Error Code: {code}"))),
            "{failure:?}"
        );
        assert_eq!(self.snapshot(), before);
        for (key, old) in keys.iter().zip(stored) {
            assert_eq!(self.svm.get_account(key), old);
        }
    }
    /// Builds same-price FIFO append with an explicit tail hint.
    ///
    /// # Inputs
    /// Fixture owner/position, outcome/side/price/quantity, order ID and supplied tail key.
    ///
    /// # Errors
    /// No program Result is returned; runtime validation happens only after submission.
    ///
    /// # Returns
    /// An append Instruction that may intentionally contain stale IDs or tail hints.
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
            outcomia::ID,
            &outcomia::instruction::AppendPredictionOrder {
                order_id,
                outcome,
                side,
                price,
                quantity,
            }
            .data(),
            outcomia::accounts::AppendPredictionOrder {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                order_book: self.book,
                price_level: outcomia::derive_prediction_price_level_pda(
                    &outcomia::ID,
                    &self.market,
                    outcome,
                    side,
                    price,
                )
                .0,
                tail_order: tail,
                order: outcomia::derive_prediction_order_pda(&outcomia::ID, &self.market, order_id)
                    .0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }
    /// Asserts append failure preserves both old queue and attempted new order.
    ///
    /// # Inputs
    /// Mutable fixture, append instruction and expected Anchor error-code name.
    ///
    /// # Errors
    /// Panics on wrong result/code or changed snapshots.
    ///
    /// # Returns
    /// Unit after custody/ledger/book, level, tail and new-order account comparisons.
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
    /// Creates a second non-admin trader while retaining the original claims.
    ///
    /// # Inputs
    /// Mutable fixture containing a collateral mint/vault and an open prediction market.
    ///
    /// # Errors
    /// Panics on faucet-fixture packing, ledger initialization, deposit or split failure.
    ///
    /// # Returns
    /// Current owner/position become a new wallet: 20 collateral tokens deposited, 5 pairs split,
    /// leaving 15 free cash and 5 free YES/NO.
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
        self.position = outcomia::derive_prediction_position_pda(
            &outcomia::ID,
            &self.market,
            &self.owner.pubkey(),
        )
        .0;
        let init = Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializePredictionPosition {}.data(),
            outcomia::accounts::InitializePredictionPosition {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let deposit = Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::DepositPredictionCollateral { amount: 20_000_000 }.data(),
            outcomia::accounts::DepositPredictionCollateral {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                collateral_mint: mint_key,
                source,
                vault_authority: Pubkey::find_program_address(
                    &[b"vault-authority", self.market.as_ref()],
                    &outcomia::ID,
                )
                .0,
                collateral_vault: self.vault,
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        );
        let split = Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::SplitPredictionCompleteSet { quantity: 5 }.data(),
            outcomia::accounts::PredictionCompleteSet {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
            }
            .to_account_metas(None),
        );
        assert!(send(&mut self.svm, &self.owner, &[init, deposit, split]).is_ok());
    }
    /// Builds a funded and open prediction-market integration fixture.
    ///
    /// # Inputs
    /// No arguments; fresh VM, synthetic mint/admin setup and the compiled SBF artifact.
    ///
    /// # Errors
    /// Panics on fixture installation or any required initialize/open/deposit/split transaction
    /// failure.
    ///
    /// # Returns
    /// Fixture whose ordinary trader has 90 free collateral tokens and 10 YES/NO pairs backed by a
    /// 10-token reserve.
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM).unwrap();
        let creator = Keypair::new();
        let owner = Keypair::new();
        for key in [creator.pubkey(), owner.pubkey()] {
            svm.airdrop(&key, 2_000_000_000).unwrap();
        }
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = 100;
        svm.set_sysvar(&clock);
        let (admin, bump) =
            Pubkey::find_program_address(&[b"admin", creator.pubkey().as_ref()], &outcomia::ID);
        let mut data = Vec::new();
        AdminRecord {
            authority: creator.pubkey(),
            added_by: creator.pubkey(),
            status: AdminStatus::Active,
            bump,
        }
        .try_serialize(&mut data)
        .unwrap();
        account(&mut svm, admin, data, outcomia::ID);
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
        let market = outcomia::derive_prediction_market_pda(&outcomia::ID, &[7; 32]).0;
        let book = outcomia::derive_prediction_book_pda(&outcomia::ID, &market).0;
        let position =
            outcomia::derive_prediction_position_pda(&outcomia::ID, &market, &owner.pubkey()).0;
        let authority =
            Pubkey::find_program_address(&[b"vault-authority", market.as_ref()], &outcomia::ID).0;
        let vault = Pubkey::find_program_address(
            &[b"vault", market.as_ref(), mint.as_ref()],
            &outcomia::ID,
        )
        .0;
        let fees = outcomia::derive_market_fees_pda(&outcomia::ID, &market).0;
        let init = Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializePredictionMarket {
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
            outcomia::accounts::InitializePredictionMarket {
                authority: creator.pubkey(),
                admin_record: admin,
                market,
                collateral_mint: mint,
                vault_authority: authority,
                collateral_vault: vault,
                market_metadata: outcomia::derive_market_metadata_pda(&outcomia::ID, &market).0,
                market_fees: fees,
                order_book: book,
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let open = Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::OpenPredictionMarket {}.data(),
            outcomia::accounts::OpenPredictionMarket {
                authority: creator.pubkey(),
                market,
                admin_record: admin,
            }
            .to_account_metas(None),
        );
        assert!(send(&mut svm, &creator, &[init, open]).is_ok());
        let init_position = Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializePredictionPosition {}.data(),
            outcomia::accounts::InitializePredictionPosition {
                owner: owner.pubkey(),
                market,
                position,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let deposit = Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::DepositPredictionCollateral {
                amount: 100_000_000,
            }
            .data(),
            outcomia::accounts::DepositPredictionCollateral {
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
            outcomia::ID,
            &outcomia::instruction::SplitPredictionCompleteSet { quantity: 10 }.data(),
            outcomia::accounts::PredictionCompleteSet {
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
    /// Builds first-order placement on an expected empty side.
    ///
    /// # Inputs
    /// Fixture owner/position, outcome/side, raw price, whole quantity and explicit order ID.
    ///
    /// # Errors
    /// No program Result; wrong IDs, funding or occupied sides are tested when executing.
    ///
    /// # Returns
    /// PlacePredictionOrder Instruction with canonical market/book/level/order accounts.
    fn ix(
        &self,
        outcome: PredictionOutcome,
        side: OrderSide,
        price: u64,
        quantity: u64,
        order_id: u64,
    ) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::PlacePredictionOrder {
                order_id,
                outcome,
                side,
                price,
                quantity,
            }
            .data(),
            outcomia::accounts::PlacePredictionOrder {
                owner: self.owner.pubkey(),
                market: self.market,
                position: self.position,
                order_book: self.book,
                price_level: outcomia::derive_prediction_price_level_pda(
                    &outcomia::ID,
                    &self.market,
                    outcome,
                    side,
                    price,
                )
                .0,
                order: outcomia::derive_prediction_order_pda(&outcomia::ID, &self.market, order_id)
                    .0,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }
    /// Captures the fixture's principal state for rollback assertions.
    ///
    /// # Inputs
    /// Borrowed fixture with existing market/book/position/vault/source/fees.
    ///
    /// # Errors
    /// Panics if a required fixture account is missing.
    ///
    /// # Returns
    /// Full Account copies, including data/lamports/owner, excluding the signer wallet so SOL fees
    /// do not create false failures.
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
    /// Checks first-placement rejection and allocation rollback.
    ///
    /// # Inputs
    /// Mutable fixture, placement instruction and expected error-code name.
    ///
    /// # Errors
    /// Panics on unexpected success/code, changed principal state or surviving new level/order.
    ///
    /// # Returns
    /// Unit after confirming no funded order or partially created level escaped the failed
    /// transaction.
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
fn prediction_partial_and_full_fills_settle_both_outcomes_at_maker_price_with_fees() {
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for maker_side in [OrderSide::Bid, OrderSide::Ask] {
            let taker_side = if maker_side == OrderSide::Bid {
                OrderSide::Ask
            } else {
                OrderSide::Bid
            };
            let mut f = Fixture::new();
            f.set_fee_rate(100);
            f.seed_queue(outcome, maker_side, 1);
            let maker_position = f.position;
            let rent_payer = f.owner.pubkey();
            let maker_start: PredictionPosition = read(&f.svm, maker_position);
            f.switch_to_funded_trader();
            let taker_start: PredictionPosition = read(&f.svm, f.position);
            let vault = f.svm.get_account(&f.vault);
            let market_before: PredictionMarket = read(&f.svm, f.market);
            let level_key = f.level(outcome, maker_side, 600000);
            let level_before: PredictionPriceLevel = read(&f.svm, level_key);
            let limit = if taker_side == OrderSide::Bid {
                800000
            } else {
                400000
            };
            let ix = f.match_ix(1, outcome, taker_side, limit, 1);
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            let order: PredictionOrder = read(&f.svm, f.order_key(1));
            assert_eq!(
                (order.remaining_quantity, order.status),
                (1, OrderStatus::Open)
            );
            assert_eq!(
                order.locked_collateral,
                if maker_side == OrderSide::Bid {
                    600000
                } else {
                    1
                }
            );
            let level: PredictionPriceLevel = read(&f.svm, level_key);
            assert_eq!((level.order_count, level.total_remaining_quantity), (1, 1));
            assert_eq!(
                (
                    level.first_order,
                    level.last_order,
                    level.better_price,
                    level.worse_price
                ),
                (
                    level_before.first_order,
                    level_before.last_order,
                    level_before.better_price,
                    level_before.worse_price
                )
            );
            let maker: PredictionPosition = read(&f.svm, maker_position);
            let taker: PredictionPosition = read(&f.svm, f.position);
            if taker_side == OrderSide::Bid {
                assert_eq!(maker.collateral_free - maker_start.collateral_free, 600000);
                assert_eq!(taker_start.collateral_free - taker.collateral_free, 606000);
            } else {
                assert_eq!(
                    maker_start.collateral_locked - maker.collateral_locked,
                    600000
                );
                assert_eq!(taker.collateral_free - taker_start.collateral_free, 594000);
            }
            f.assert_trade_conservation(maker_position);
            assert_eq!(f.svm.get_account(&f.vault), vault);
            let rent_before = f.svm.get_account(&rent_payer).unwrap().lamports;
            let rent = f.svm.get_account(&level_key).unwrap().lamports;
            // Request more than remains: execute only one contract, never post 99.
            let ix = f.match_ix(1, outcome, taker_side, limit, 100);
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            let order: PredictionOrder = read(&f.svm, f.order_key(1));
            assert_eq!(
                (
                    order.status,
                    order.remaining_quantity,
                    order.locked_collateral,
                    order.previous_order,
                    order.next_order
                ),
                (OrderStatus::Filled, 0, 0, None, None)
            );
            assert_eq!(order.quantity, 2);
            assert!(f.svm.get_account(&level_key).is_none());
            assert!(f.svm.get_account(&f.order_key(2)).is_none());
            assert_eq!(
                f.svm.get_account(&rent_payer).unwrap().lamports,
                rent_before + rent
            );
            let book: PredictionOrderBook = read(&f.svm, f.book);
            assert_eq!(book.best_price(outcome, maker_side), None);
            assert_eq!(book.next_order_id, 2);
            let market: PredictionMarket = read(&f.svm, f.market);
            assert_eq!(market.open_order_count, 0);
            assert_eq!(
                (market.backing_reserve, market.yes_supply, market.no_supply),
                (
                    market_before.backing_reserve,
                    market_before.yes_supply,
                    market_before.no_supply
                )
            );
            let fees: MarketFees = read(&f.svm, f.fees);
            assert_eq!(fees.accrued_quote_fees, 12000);
            f.assert_trade_conservation(maker_position);
        }
    }
}

/// Execute matching followed by safe remainder placement in the same transaction.
///
/// # Inputs
/// Fresh fixtures for YES/NO, buy/sell, an empty own side or an existing worse price.
///
/// # Errors
/// Panics on rejected valid execution, incorrect lock/IDs or broken asset conservation.
///
/// # Returns
/// Unit after proving the remaining two contracts rest using post-fill funds.
#[test]
fn prediction_match_then_remainder_place_or_insert_is_atomic_and_conserves_assets() {
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for side in [OrderSide::Bid, OrderSide::Ask] {
            for occupied in [false, true] {
                let mut f = Fixture::new();
                f.set_fee_rate(100);
                let maker_side = if side == OrderSide::Bid {
                    OrderSide::Ask
                } else {
                    OrderSide::Bid
                };
                let maker = f.ix(outcome, maker_side, 600000, 1, 1);
                send(&mut f.svm, &f.owner, &[maker]).unwrap();
                let maker_position = f.position;
                f.switch_to_funded_trader();
                let worse = if side == OrderSide::Bid {
                    400000
                } else {
                    800000
                };
                if occupied {
                    let own = f.ix(outcome, side, worse, 1, 2);
                    send(&mut f.svm, &f.owner, &[own]).unwrap();
                }
                let limit = if side == OrderSide::Bid {
                    700000
                } else {
                    500000
                };
                let next_id = if occupied { 3 } else { 2 };
                let fill = f.match_ix(1, outcome, side, limit, 3);
                let placement = if occupied {
                    f.insert(outcome, side, limit, 2, (None, Some(worse)))
                } else {
                    f.ix(outcome, side, limit, 2, next_id)
                };
                let custody = f.svm.get_account(&f.vault);
                let result = send(&mut f.svm, &f.owner, &[fill, placement]).unwrap();
                assert!(result.compute_units_consumed <= 600_000);
                let order: PredictionOrder = read(&f.svm, f.order_key(next_id));
                assert_eq!(order.owner, f.owner.pubkey());
                assert_eq!(
                    (order.status, order.remaining_quantity),
                    (OrderStatus::Open, 2)
                );
                assert_eq!(
                    order.locked_collateral,
                    if side == OrderSide::Bid { 1400000 } else { 2 }
                );
                let book: PredictionOrderBook = read(&f.svm, f.book);
                assert_eq!(book.next_order_id, next_id + 1);
                let fees: MarketFees = read(&f.svm, f.fees);
                assert_eq!(fees.accrued_quote_fees, 6000);
                assert_eq!(f.svm.get_account(&f.vault), custody);
                f.assert_trade_conservation(maker_position);
            }
        }
    }
}

/// A rejected remainder must roll back the preceding fill and its fee.
///
/// # Inputs
/// One crossing maker followed by an intentionally underfunded remainder.
///
/// # Errors
/// Panics if execution succeeds or any maker, ledger, book or fee state changes.
///
/// # Returns
/// Unit after proving atomic rollback for both outcome assets and directions.
#[test]
fn prediction_failed_remainder_rolls_back_matching_and_fees() {
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for side in [OrderSide::Bid, OrderSide::Ask] {
            let mut f = Fixture::new();
            f.set_fee_rate(100);
            let maker_side = if side == OrderSide::Bid {
                OrderSide::Ask
            } else {
                OrderSide::Bid
            };
            let ix = f.ix(outcome, maker_side, 600000, 1, 1);
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            let maker_position = f.position;
            f.switch_to_funded_trader();
            let keys = [
                f.market,
                f.book,
                f.position,
                maker_position,
                f.fees,
                f.order_key(1),
                f.level(outcome, maker_side, 600000),
                f.vault,
            ];
            let before: Vec<_> = keys.iter().map(|key| f.svm.get_account(key)).collect();
            let limit = if side == OrderSide::Bid {
                700000
            } else {
                500000
            };
            let fill = f.match_ix(1, outcome, side, limit, 1001);
            let rest = f.ix(outcome, side, limit, 1000, 2);
            assert!(send(&mut f.svm, &f.owner, &[fill, rest]).is_err());
            let after: Vec<_> = keys.iter().map(|key| f.svm.get_account(key)).collect();
            assert_eq!(before, after);
            assert!(f.svm.get_account(&f.order_key(2)).is_none());
            f.assert_trade_conservation(maker_position);
        }
    }
}

/// Execute promoted heads within one transaction, not a sequence of committed fills.
///
/// # Inputs
/// No external arguments; fresh fixtures cover both outcomes/sides and requests of 5 or 6 contracts.
///
/// # Errors
/// Panics on fixture failure, rejected valid batch, wrong funding/counts/rent or broken conservation.
///
/// # Returns
/// Unit after proving full-prefix fills and a partial/full final maker commit atomically.
#[test]
fn prediction_three_maker_fifo_batches_settle_atomically_with_partial_or_full_last_fill() {
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for maker_side in [OrderSide::Bid, OrderSide::Ask] {
            for requested in [5, 6] {
                let mut f = Fixture::new();
                f.set_fee_rate(25);
                f.seed_queue(outcome, maker_side, 3);
                let maker_position = f.position;
                let rent_payer = f.owner.pubkey();
                let level_key = f.level(outcome, maker_side, 600000);
                let rent = f.svm.get_account(&level_key).unwrap().lamports;
                f.switch_to_funded_trader();
                // Selling six contracts needs one more free pair than this
                // trader's default five. Use a real split before matching.
                if requested == 6 && maker_side == OrderSide::Bid {
                    let split = Instruction::new_with_bytes(
                        outcomia::ID,
                        &outcomia::instruction::SplitPredictionCompleteSet { quantity: 1 }.data(),
                        outcomia::accounts::PredictionCompleteSet {
                            owner: f.owner.pubkey(),
                            market: f.market,
                            position: f.position,
                        }
                        .to_account_metas(None),
                    );
                    send(&mut f.svm, &f.owner, &[split]).unwrap();
                }
                let taker_side = if maker_side == OrderSide::Ask {
                    OrderSide::Bid
                } else {
                    OrderSide::Ask
                };
                let first = f.match_ix(1, outcome, taker_side, 600000, requested);
                let second = f.match_ix(2, outcome, taker_side, 600000, requested - 2);
                let mut third = f.match_ix(3, outcome, taker_side, 600000, requested - 4);
                // All three instructions are built from the same RPC-era state.
                // Earlier fills leave the third as a singleton, although the
                // stored level currently says three orders. Supply its rent
                // hint only when this last fill will close the simulated level.
                if requested == 6 {
                    third.accounts[11].pubkey = rent_payer;
                    third.accounts[11].is_writable = true;
                }
                let custody = f.svm.get_account(&f.vault);
                let reserve: PredictionMarket = read(&f.svm, f.market);
                let rent_before = f.svm.get_account(&rent_payer).unwrap().lamports;
                let result = send(&mut f.svm, &f.owner, &[first, second, third]).unwrap();
                assert!(result.compute_units_consumed <= 600_000, "{result:?}");
                for id in [1, 2] {
                    let order: PredictionOrder = read(&f.svm, f.order_key(id));
                    assert_eq!(
                        (
                            order.status,
                            order.remaining_quantity,
                            order.locked_collateral
                        ),
                        (OrderStatus::Filled, 0, 0)
                    );
                }
                let last: PredictionOrder = read(&f.svm, f.order_key(3));
                assert_eq!(last.remaining_quantity, 6 - requested);
                assert_eq!(last.previous_order, None);
                let market: PredictionMarket = read(&f.svm, f.market);
                assert_eq!(market.open_order_count, u64::from(requested != 6));
                assert_eq!(
                    (market.yes_supply, market.no_supply, market.backing_reserve),
                    (
                        reserve.yes_supply,
                        reserve.no_supply,
                        reserve.backing_reserve
                    )
                );
                let book: PredictionOrderBook = read(&f.svm, f.book);
                assert_eq!(book.next_order_id, 4);
                let fees: MarketFees = read(&f.svm, f.fees);
                assert_eq!(fees.accrued_quote_fees, 1500 * requested);
                assert_eq!(f.svm.get_account(&f.vault), custody);
                if requested == 6 {
                    assert!(f.svm.get_account(&level_key).is_none());
                    assert_eq!(book.best_price(outcome, maker_side), None);
                    assert_eq!(
                        f.svm.get_account(&rent_payer).unwrap().lamports,
                        rent_before + rent
                    );
                } else {
                    let level: PredictionPriceLevel = read(&f.svm, level_key);
                    assert_eq!(
                        (
                            level.first_order,
                            level.last_order,
                            level.order_count,
                            level.total_remaining_quantity
                        ),
                        (Some(f.order_key(3)), Some(f.order_key(3)), 1, 1)
                    );
                }
                f.assert_trade_conservation(maker_position);
            }
        }
    }
}

/// Each later instruction observes the preceding instruction's repaired best pointer.
///
/// # Inputs
/// No external arguments; three-price fixtures for both outcomes and sides use real resting orders.
///
/// # Errors
/// Panics if execution rejects valid promotions, custody changes or rent/fee/account totals disagree.
///
/// # Returns
/// Unit after all three levels close under one transaction and all claims remain backed.
#[test]
fn prediction_three_price_batches_promote_levels_and_return_each_original_payers_rent() {
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for maker_side in [OrderSide::Bid, OrderSide::Ask] {
            let mut f = Fixture::new();
            f.set_fee_rate(100);
            let prices = if maker_side == OrderSide::Ask {
                [600000, 610000, 620000]
            } else {
                [600000, 590000, 580000]
            };
            let first = f.ix(outcome, maker_side, prices[0], 1, 1);
            send(&mut f.svm, &f.owner, &[first]).unwrap();
            for i in 1..3 {
                let ix = f.insert(
                    outcome,
                    maker_side,
                    prices[i],
                    1,
                    (Some(prices[i - 1]), None),
                );
                send(&mut f.svm, &f.owner, &[ix]).unwrap();
            }
            let maker_position = f.position;
            let rent_payer = f.owner.pubkey();
            let rent: u64 = prices
                .iter()
                .map(|p| {
                    f.svm
                        .get_account(&f.level(outcome, maker_side, *p))
                        .unwrap()
                        .lamports
                })
                .sum();
            f.switch_to_funded_trader();
            let side = if maker_side == OrderSide::Ask {
                OrderSide::Bid
            } else {
                OrderSide::Ask
            };
            let limit = if side == OrderSide::Bid {
                700000
            } else {
                500000
            };
            let instructions: Vec<_> = (1..=3)
                .map(|id| f.match_ix(id, outcome, side, limit, 4 - id))
                .collect();
            let owner_before = f.svm.get_account(&rent_payer).unwrap().lamports;
            let result = send(&mut f.svm, &f.owner, &instructions).unwrap();
            assert!(result.compute_units_consumed <= 600_000, "{result:?}");
            let book: PredictionOrderBook = read(&f.svm, f.book);
            assert_eq!(book.best_price(outcome, maker_side), None);
            assert_eq!(book.next_order_id, 4);
            for price in prices {
                assert!(f
                    .svm
                    .get_account(&f.level(outcome, maker_side, price))
                    .is_none());
            }
            assert_eq!(
                f.svm.get_account(&rent_payer).unwrap().lamports,
                owner_before + rent
            );
            let fees: MarketFees = read(&f.svm, f.fees);
            assert_eq!(fees.accrued_quote_fees, prices.iter().sum::<u64>() / 100);
            f.assert_trade_conservation(maker_position);
        }
    }
}

/// A third-step failure must undo the two earlier successful fills and rent transfers.
///
/// # Inputs
/// No external arguments; a three-price buy batch has an intentionally non-crossing final limit.
///
/// # Errors
/// Panics if the final step succeeds, the wrong error occurs or any tracked account survives changed.
///
/// # Returns
/// Unit after all three invocations are observed and ledger/fee/book/rent snapshots match pre-batch state.
#[test]
fn prediction_third_match_failure_rolls_back_the_entire_three_price_batch() {
    let mut f = Fixture::new();
    f.set_fee_rate(100);
    let first = f.ix(PredictionOutcome::Yes, OrderSide::Ask, 600000, 1, 1);
    send(&mut f.svm, &f.owner, &[first]).unwrap();
    for (price, better) in [(610000, 600000), (620000, 610000)] {
        let ix = f.insert(
            PredictionOutcome::Yes,
            OrderSide::Ask,
            price,
            1,
            (Some(better), None),
        );
        send(&mut f.svm, &f.owner, &[ix]).unwrap();
    }
    let maker_position = f.position;
    let maker_owner = f.owner.pubkey();
    f.switch_to_funded_trader();
    let before = f.snapshot();
    let keys = [
        maker_position,
        maker_owner,
        f.order_key(1),
        f.order_key(2),
        f.order_key(3),
        f.level(PredictionOutcome::Yes, OrderSide::Ask, 600000),
        f.level(PredictionOutcome::Yes, OrderSide::Ask, 610000),
        f.level(PredictionOutcome::Yes, OrderSide::Ask, 620000),
    ];
    let accounts: Vec<_> = keys.iter().map(|key| f.svm.get_account(key)).collect();
    let instructions = [
        f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 700000, 3),
        f.match_ix(2, PredictionOutcome::Yes, OrderSide::Bid, 700000, 2),
        f.match_ix(3, PredictionOutcome::Yes, OrderSide::Bid, 600000, 1),
    ];
    let result = send(&mut f.svm, &f.owner, &instructions).unwrap_err();
    assert_eq!(
        result
            .meta
            .logs
            .iter()
            .filter(|line| line.contains("Instruction: MatchPredictionOrder"))
            .count(),
        3
    );
    assert!(result
        .meta
        .logs
        .iter()
        .any(|line| line.contains("PredictionOrdersDoNotCross")));
    assert_eq!(f.snapshot(), before);
    for (key, before) in keys.iter().zip(accounts) {
        assert_eq!(f.svm.get_account(key), before);
    }
    f.assert_trade_conservation(maker_position);
}

#[test]
fn full_fills_promote_fifo_then_worse_price_without_creating_taker_orders() {
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for maker_side in [OrderSide::Bid, OrderSide::Ask] {
            let mut f = Fixture::new();
            f.set_fee_rate(0);
            f.seed_queue(outcome, maker_side, 2);
            let worse = if maker_side == OrderSide::Bid {
                500000
            } else {
                700000
            };
            let ix = f.insert(outcome, maker_side, worse, 1, (Some(600000), None));
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            let maker_position = f.position;
            f.switch_to_funded_trader();
            let taker_side = if maker_side == OrderSide::Bid {
                OrderSide::Ask
            } else {
                OrderSide::Bid
            };
            let limit = if taker_side == OrderSide::Bid {
                800000
            } else {
                400000
            };
            let ix = f.match_ix(1, outcome, taker_side, limit, 2);
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            let next: PredictionOrder = read(&f.svm, f.order_key(2));
            assert_eq!(next.previous_order, None);
            let level: PredictionPriceLevel = read(&f.svm, f.level(outcome, maker_side, 600000));
            assert_eq!(
                (
                    level.first_order,
                    level.last_order,
                    level.order_count,
                    level.total_remaining_quantity
                ),
                (Some(f.order_key(2)), Some(f.order_key(2)), 1, 2)
            );
            let ix = f.match_ix(2, outcome, taker_side, limit, 2);
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            assert!(f
                .svm
                .get_account(&f.level(outcome, maker_side, 600000))
                .is_none());
            let level: PredictionPriceLevel = read(&f.svm, f.level(outcome, maker_side, worse));
            assert_eq!(level.better_price, None);
            let book: PredictionOrderBook = read(&f.svm, f.book);
            assert_eq!(book.best_price(outcome, maker_side), Some(worse));
            assert_eq!(book.next_order_id, 4);
            let ix = f.match_ix(3, outcome, taker_side, limit, 1);
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            f.assert_trade_conservation(maker_position);
        }
    }
}

#[test]
fn matching_rejects_self_trade_same_side_non_crossing_and_skipped_priority() {
    let mut f = Fixture::new();
    f.set_fee_rate(0);
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Ask, 2);
    let ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 700000, 1);
    // Anchor rejects aliasing maker/taker ledgers before handler constraints.
    f.reject_match(ix, "ConstraintDuplicateMutableAccount");
    let ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Ask,
        700000,
        1,
        (Some(600000), None),
    );
    send(&mut f.svm, &f.owner, &[ix]).unwrap();
    f.switch_to_funded_trader();
    for (id, side, price, qty, code) in [
        (1, OrderSide::Ask, 600000, 1, "PredictionMatchingSameSide"),
        (1, OrderSide::Bid, 500000, 1, "PredictionOrdersDoNotCross"),
        (1, OrderSide::Bid, 600001, 1, "InvalidPredictionOrderPrice"),
        (1, OrderSide::Bid, 0, 1, "InvalidPredictionOrderPrice"),
        (1, OrderSide::Bid, 1000000, 1, "InvalidPredictionOrderPrice"),
        (
            1,
            OrderSide::Bid,
            700000,
            0,
            "InvalidPredictionContractQuantity",
        ),
        (2, OrderSide::Bid, 700000, 1, "PredictionMakerNotHead"),
        (3, OrderSide::Bid, 700000, 1, "PredictionMakerNotBest"),
    ] {
        let ix = f.match_ix(id, PredictionOutcome::Yes, side, price, qty);
        f.reject_match(ix, code);
    }
}

#[test]
fn matching_rejects_closed_markets_and_stops_at_exact_close_time() {
    let mut f = Fixture::new();
    f.set_fee_rate(0);
    f.seed_queue(PredictionOutcome::No, OrderSide::Bid, 1);
    f.switch_to_funded_trader();
    let original = f.svm.get_account(&f.market).unwrap();
    for status in [
        PredictionStatus::Draft,
        PredictionStatus::Frozen,
        PredictionStatus::Proposed,
        PredictionStatus::Resolved,
    ] {
        let mut m: PredictionMarket = read(&f.svm, f.market);
        m.status = status;
        write(&mut f.svm, f.market, &m);
        let ix = f.match_ix(1, PredictionOutcome::No, OrderSide::Ask, 600000, 1);
        f.reject_match(ix, "PredictionOrderUnavailable");
    }
    f.svm.set_account(f.market, original).unwrap();
    let m: PredictionMarket = read(&f.svm, f.market);
    let mut clock = f.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = m.close_ts;
    f.svm.set_sysvar(&clock);
    let ix = f.match_ix(1, PredictionOutcome::No, OrderSide::Ask, 600000, 1);
    f.reject_match(ix, "PredictionOrderUnavailable");
}

#[test]
fn matching_checks_free_funds_fee_bounds_and_checked_receiving_balances() {
    for maker_side in [OrderSide::Ask, OrderSide::Bid] {
        let mut f = Fixture::new();
        f.set_fee_rate(100);
        f.seed_queue(PredictionOutcome::Yes, maker_side, 1);
        let maker_position = f.position;
        f.switch_to_funded_trader();
        let side = if maker_side == OrderSide::Ask {
            OrderSide::Bid
        } else {
            OrderSide::Ask
        };
        let original = f.svm.get_account(&f.position).unwrap();
        let mut p: PredictionPosition = read(&f.svm, f.position);
        if side == OrderSide::Bid {
            p.collateral_free = 600000;
        } else {
            p.yes_free = 0;
        }
        write(&mut f.svm, f.position, &p);
        let ix = f.match_ix(1, PredictionOutcome::Yes, side, 600000, 1);
        f.reject_match(
            ix,
            if side == OrderSide::Bid {
                "InsufficientFreeBalance"
            } else {
                "InsufficientPredictionPositions"
            },
        );
        f.svm.set_account(f.position, original).unwrap();
        let maker_original = f.svm.get_account(&maker_position).unwrap();
        let mut p: PredictionPosition = read(&f.svm, maker_position);
        if side == OrderSide::Bid {
            p.collateral_free = u64::MAX;
        } else {
            p.yes_free = u64::MAX;
        }
        write(&mut f.svm, maker_position, &p);
        let ix = f.match_ix(1, PredictionOutcome::Yes, side, 600000, 1);
        f.reject_match(
            ix,
            if side == OrderSide::Bid {
                "FreeBalanceOverflow"
            } else {
                "PredictionAccountingOverflow"
            },
        );
        f.svm.set_account(maker_position, maker_original).unwrap();
        let taker_original = f.svm.get_account(&f.position).unwrap();
        let mut p: PredictionPosition = read(&f.svm, f.position);
        if side == OrderSide::Bid {
            p.yes_free = u64::MAX;
        } else {
            p.collateral_free = u64::MAX;
        }
        write(&mut f.svm, f.position, &p);
        let ix = f.match_ix(1, PredictionOutcome::Yes, side, 600000, 1);
        f.reject_match(
            ix,
            if side == OrderSide::Bid {
                "PredictionAccountingOverflow"
            } else {
                "FreeBalanceOverflow"
            },
        );
        f.svm.set_account(f.position, taker_original).unwrap();
        let mut fees: MarketFees = read(&f.svm, f.fees);
        fees.accrued_quote_fees = u64::MAX;
        write(&mut f.svm, f.fees, &fees);
        let ix = f.match_ix(1, PredictionOutcome::Yes, side, 600000, 1);
        f.reject_match(ix, "FeeAccrualOverflow");
        fees.accrued_quote_fees = 0;
        write(&mut f.svm, f.fees, &fees);
        f.set_fee_rate(1001);
        let ix = f.match_ix(1, PredictionOutcome::Yes, side, 600000, 1);
        f.reject_match(ix, "FeeRateTooHigh");
    }
}

#[test]
fn matching_requires_exact_removal_hints_and_rejects_stale_or_corrupt_neighbors() {
    let mut f = Fixture::new();
    f.set_fee_rate(0);
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Ask, 2);
    let maker_owner = f.owner.insecure_clone();
    let maker_position = f.position;
    f.switch_to_funded_trader();
    let mut ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 600000, 1);
    ix.accounts[9].pubkey = f.order_key(2);
    ix.accounts[9].is_writable = true;
    f.reject_match(ix, "InvalidPredictionOrderNeighbor");
    let mut ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 600000, 2);
    ix.accounts[9].pubkey = outcomia::ID;
    f.reject_match(ix, "InvalidPredictionOrderNeighbor");
    let key = f.order_key(2);
    let stored = f.svm.get_account(&key).unwrap();
    let mut successor: PredictionOrder = read(&f.svm, key);
    successor.previous_order = None;
    write(&mut f.svm, key, &successor);
    let ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 600000, 2);
    f.reject_match(ix, "InvalidPredictionOrderNeighbor");
    f.svm.set_account(key, stored).unwrap();
    let stale = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 600000, 1);
    let taker = std::mem::replace(&mut f.owner, maker_owner);
    let taker_position = std::mem::replace(&mut f.position, maker_position);
    let ix = f.cancel(1);
    send(&mut f.svm, &f.owner, &[ix]).unwrap();
    f.owner = taker;
    f.position = taker_position;
    f.reject_match(stale, "PredictionOrderNotOpen");
    let mut ix = f.match_ix(2, PredictionOutcome::Yes, OrderSide::Bid, 600000, 2);
    ix.accounts[11].pubkey = f.owner.pubkey();
    f.reject_match(ix, "InvalidPredictionRentRecipient");
}

#[test]
fn matching_rejects_wrong_namespaces_fee_bindings_signatures_and_maker_backing() {
    let mut f = Fixture::new();
    f.set_fee_rate(0);
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Ask, 1);
    f.switch_to_funded_trader();
    for index in [1, 2, 3, 4, 5, 6, 7, 8] {
        let mut ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 600000, 1);
        let fake = Pubkey::new_unique();
        f.svm
            .set_account(fake, f.svm.get_account(&ix.accounts[index].pubkey).unwrap())
            .unwrap();
        ix.accounts[index].pubkey = fake;
        f.reject_match(ix, "ConstraintSeeds");
    }
    let ix = f.match_ix(1, PredictionOutcome::No, OrderSide::Bid, 600000, 1);
    f.reject_match(ix, "InvalidPredictionPriceLevel");
    let payer = Keypair::new();
    f.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let mut ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 600000, 1);
    ix.accounts[0].is_signer = false;
    let before = f.snapshot();
    let result = send(&mut f.svm, &payer, &[ix]).unwrap_err();
    assert!(
        result
            .meta
            .logs
            .iter()
            .any(|s| s.contains("AccountNotSigner")),
        "{result:?}"
    );
    assert_eq!(f.snapshot(), before);
    let stored = f.svm.get_account(&f.fees).unwrap();
    let mut fees: MarketFees = read(&f.svm, f.fees);
    fees.quote_mint = Pubkey::new_unique();
    write(&mut f.svm, f.fees, &fees);
    let ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 600000, 1);
    f.reject_match(ix, "MarketFeesQuoteMintMismatch");
    f.svm.set_account(f.fees, stored).unwrap();
    let key = f.order_key(1);
    let mut order: PredictionOrder = read(&f.svm, key);
    order.locked_collateral += 1;
    write(&mut f.svm, key, &order);
    let ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 600000, 1);
    f.reject_match(ix, "PredictionOrderAccountingMismatch");
}

#[test]
fn matching_can_be_followed_by_real_owner_cancellation_of_only_the_remainder() {
    for maker_side in [OrderSide::Ask, OrderSide::Bid] {
        let mut f = Fixture::new();
        f.set_fee_rate(100);
        f.seed_queue(PredictionOutcome::No, maker_side, 1);
        let maker_owner = f.owner.insecure_clone();
        let maker_position = f.position;
        f.switch_to_funded_trader();
        let taker_position = f.position;
        let side = if maker_side == OrderSide::Ask {
            OrderSide::Bid
        } else {
            OrderSide::Ask
        };
        let ix = f.match_ix(1, PredictionOutcome::No, side, 600000, 1);
        send(&mut f.svm, &f.owner, &[ix]).unwrap();
        f.assert_trade_conservation(maker_position);
        let before: PredictionPosition = read(&f.svm, maker_position);
        f.owner = maker_owner;
        f.position = maker_position;
        let ix = f.cancel(1);
        send(&mut f.svm, &f.owner, &[ix]).unwrap();
        let after: PredictionPosition = read(&f.svm, maker_position);
        if maker_side == OrderSide::Bid {
            assert_eq!(
                (
                    after.collateral_locked,
                    after.collateral_free - before.collateral_free
                ),
                (0, 600000)
            );
        } else {
            assert_eq!((after.no_locked, after.no_free - before.no_free), (0, 1));
        }
        f.position = taker_position;
        f.assert_trade_conservation(maker_position);
    }
}

#[test]
fn matching_fee_rounding_and_zero_or_max_rates_preserve_custody_at_tiny_notionals() {
    for rate in [0, 1, 1000] {
        for maker_side in [OrderSide::Ask, OrderSide::Bid] {
            let mut f = Fixture::new();
            f.set_fee_rate(rate);
            let mut market: PredictionMarket = read(&f.svm, f.market);
            market.price_tick = 1;
            write(&mut f.svm, f.market, &market);
            let ix = f.ix(PredictionOutcome::Yes, maker_side, 1, 2, 1);
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            let maker_position = f.position;
            f.switch_to_funded_trader();
            let side = if maker_side == OrderSide::Ask {
                OrderSide::Bid
            } else {
                OrderSide::Ask
            };
            let before: PredictionPosition = read(&f.svm, f.position);
            let ix = f.match_ix(1, PredictionOutcome::Yes, side, 1, 1);
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            let after: PredictionPosition = read(&f.svm, f.position);
            let fees: MarketFees = read(&f.svm, f.fees);
            let fee = u64::from(rate != 0);
            assert_eq!(fees.accrued_quote_fees, fee);
            if side == OrderSide::Bid {
                assert_eq!(before.collateral_free - after.collateral_free, 1 + fee);
            } else {
                assert_eq!(after.collateral_free - before.collateral_free, 1 - fee);
            }
            f.assert_trade_conservation(maker_position);
        }
    }
}

#[test]
fn matching_batch_failure_rolls_back_both_ledgers_fees_book_and_level_rent() {
    let mut f = Fixture::new();
    f.set_fee_rate(100);
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Ask, 1);
    let maker_position = f.position;
    let maker_owner = f.owner.pubkey();
    f.switch_to_funded_trader();
    for quantity in [1, 2] {
        let ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 700000, quantity);
        let keys = [
            maker_position,
            f.order_key(1),
            f.level(PredictionOutcome::Yes, OrderSide::Ask, 600000),
            maker_owner,
        ];
        let accounts: Vec<_> = keys.iter().map(|key| f.svm.get_account(key)).collect();
        let before = f.snapshot();
        // Partial then full without removal hints, or full then already-closed
        // level: in both cases the second instruction aborts the first fill too.
        assert!(send(&mut f.svm, &f.owner, &[ix.clone(), ix]).is_err());
        assert_eq!(f.snapshot(), before);
        for (key, account) in keys.iter().zip(accounts) {
            assert_eq!(f.svm.get_account(key), account);
        }
        f.assert_trade_conservation(maker_position);
    }
}

#[test]
fn matching_level_removal_rejects_missing_cross_outcome_and_nonreciprocal_worse_levels() {
    let mut f = Fixture::new();
    f.set_fee_rate(100);
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Ask, 1);
    let ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Ask,
        700000,
        1,
        (Some(600000), None),
    );
    send(&mut f.svm, &f.owner, &[ix]).unwrap();
    let ix = f.ix(PredictionOutcome::No, OrderSide::Ask, 700000, 1, 3);
    send(&mut f.svm, &f.owner, &[ix]).unwrap();
    f.switch_to_funded_trader();
    for replacement in [
        outcomia::ID,
        f.level(PredictionOutcome::No, OrderSide::Ask, 700000),
    ] {
        let mut ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 600000, 2);
        ix.accounts[10].pubkey = replacement;
        f.reject_match(ix, "InvalidPredictionPriceLevel");
    }
    let key = f.level(PredictionOutcome::Yes, OrderSide::Ask, 700000);
    let mut level: PredictionPriceLevel = read(&f.svm, key);
    level.better_price = None;
    write(&mut f.svm, key, &level);
    let ix = f.match_ix(1, PredictionOutcome::Yes, OrderSide::Bid, 600000, 2);
    f.reject_match(ix, "InvalidPredictionPriceLevel");
}

#[test]
fn cancellation_repairs_head_middle_tail_and_singleton_fifo_on_all_four_lists() {
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for side in [OrderSide::Bid, OrderSide::Ask] {
            for sequence in [[2, 1, 3], [3, 2, 1], [1, 3, 2]] {
                let mut f = Fixture::new();
                let original: PredictionPosition = read(&f.svm, f.position);
                f.seed_queue(outcome, side, 3);
                let vault = f.svm.get_account(&f.vault);
                let fees = f.svm.get_account(&f.fees);
                let market_before: PredictionMarket = read(&f.svm, f.market);
                let mut live = vec![1, 2, 3];
                for id in sequence {
                    let level_key = f.level(outcome, side, 600000);
                    let ix = f.cancel(id);
                    send(&mut f.svm, &f.owner, &[ix]).unwrap();
                    let order: PredictionOrder = read(&f.svm, f.order_key(id));
                    assert_eq!(
                        (
                            order.status,
                            order.remaining_quantity,
                            order.locked_collateral
                        ),
                        (OrderStatus::Canceled, 0, 0)
                    );
                    assert_eq!(
                        (order.previous_order, order.next_order, order.quantity),
                        (None, None, 2)
                    );
                    live.retain(|value| *value != id);
                    let book: PredictionOrderBook = read(&f.svm, f.book);
                    assert_eq!(book.next_order_id, 4);
                    assert_eq!(
                        book.best_price(outcome, side),
                        if live.is_empty() { None } else { Some(600000) }
                    );
                    let market: PredictionMarket = read(&f.svm, f.market);
                    assert_eq!(market.open_order_count, live.len() as u64);
                    assert_eq!(
                        (market.backing_reserve, market.yes_supply, market.no_supply),
                        (
                            market_before.backing_reserve,
                            market_before.yes_supply,
                            market_before.no_supply
                        )
                    );
                    if live.is_empty() {
                        assert!(f.svm.get_account(&level_key).is_none());
                    } else {
                        let level: PredictionPriceLevel = read(&f.svm, level_key);
                        assert_eq!(
                            (level.order_count, level.total_remaining_quantity),
                            (live.len() as u64, 2 * live.len() as u64)
                        );
                        assert_eq!(
                            (level.first_order, level.last_order),
                            (
                                live.first().map(|id| f.order_key(*id)),
                                live.last().map(|id| f.order_key(*id))
                            )
                        );
                        for (i, id) in live.iter().enumerate() {
                            let order: PredictionOrder = read(&f.svm, f.order_key(*id));
                            assert_eq!(
                                order.previous_order,
                                i.checked_sub(1).map(|j| f.order_key(live[j]))
                            );
                            assert_eq!(
                                order.next_order,
                                live.get(i + 1).map(|id| f.order_key(*id))
                            );
                        }
                    }
                    assert_eq!(f.svm.get_account(&f.vault), vault);
                    assert_eq!(f.svm.get_account(&f.fees), fees);
                }
                let restored: PredictionPosition = read(&f.svm, f.position);
                assert_eq!(
                    (
                        restored.collateral_free,
                        restored.collateral_locked,
                        restored.yes_free,
                        restored.yes_locked,
                        restored.no_free,
                        restored.no_locked
                    ),
                    (
                        original.collateral_free,
                        original.collateral_locked,
                        original.yes_free,
                        original.yes_locked,
                        original.no_free,
                        original.no_locked
                    )
                );
                // Closing a level allows reusing its price, never its old order ID.
                let ix = f.ix(outcome, side, 600000, 1, 4);
                send(&mut f.svm, &f.owner, &[ix]).unwrap();
                let old: PredictionOrder = read(&f.svm, f.order_key(1));
                assert_eq!(old.status, OrderStatus::Canceled);
            }
        }
    }
}

#[test]
fn final_order_cancellation_splices_best_middle_and_worst_prices() {
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for side in [OrderSide::Bid, OrderSide::Ask] {
            for first_removed in [1, 2, 3] {
                let mut f = Fixture::new();
                f.seed_queue(outcome, side, 1);
                let (best, worst) = if side == OrderSide::Bid {
                    (800000, 400000)
                } else {
                    (400000, 800000)
                };
                let ix = f.insert(outcome, side, best, 1, (None, Some(600000)));
                send(&mut f.svm, &f.owner, &[ix]).unwrap();
                let ix = f.insert(outcome, side, worst, 1, (Some(600000), None));
                send(&mut f.svm, &f.owner, &[ix]).unwrap();
                let mut remaining = vec![(2, best), (1, 600000), (3, worst)];
                let sequence = [first_removed]
                    .into_iter()
                    .chain([1, 2, 3].into_iter().filter(|id| *id != first_removed));
                for id in sequence {
                    let price = remaining.iter().find(|(key, _)| *key == id).unwrap().1;
                    let ix = f.cancel(id);
                    send(&mut f.svm, &f.owner, &[ix]).unwrap();
                    remaining.retain(|(key, _)| *key != id);
                    assert!(f.svm.get_account(&f.level(outcome, side, price)).is_none());
                    let book: PredictionOrderBook = read(&f.svm, f.book);
                    assert_eq!(
                        book.best_price(outcome, side),
                        remaining.first().map(|(_, p)| *p)
                    );
                    assert_eq!(book.next_order_id, 4);
                    for (i, (_, p)) in remaining.iter().enumerate() {
                        let level: PredictionPriceLevel = read(&f.svm, f.level(outcome, side, *p));
                        assert_eq!(level.better_price, i.checked_sub(1).map(|j| remaining[j].1));
                        assert_eq!(level.worse_price, remaining.get(i + 1).map(|(_, p)| *p));
                    }
                }
            }
        }
    }
}

#[test]
fn cancellation_has_no_admin_status_or_close_time_gate() {
    for status in [
        PredictionStatus::Draft,
        PredictionStatus::Open,
        PredictionStatus::Frozen,
        PredictionStatus::Proposed,
        PredictionStatus::Resolved,
    ] {
        let mut f = Fixture::new();
        f.seed_queue(PredictionOutcome::No, OrderSide::Ask, 1);
        let mut market: PredictionMarket = read(&f.svm, f.market);
        market.status = status;
        let mut clock = f.svm.get_sysvar::<Clock>();
        clock.unix_timestamp = market.close_ts;
        f.svm.set_sysvar(&clock);
        write(&mut f.svm, f.market, &market);
        let ix = f.cancel(1);
        send(&mut f.svm, &f.owner, &[ix]).unwrap();
        let market: PredictionMarket = read(&f.svm, f.market);
        assert_eq!(market.status, status);
        let position: PredictionPosition = read(&f.svm, f.position);
        assert_eq!((position.no_free, position.no_locked), (10, 0));
    }
}

#[test]
fn last_canceler_returns_level_rent_to_original_payer_not_themselves() {
    let mut f = Fixture::new();
    let alice = f.owner.insecure_clone();
    let alice_position = f.position;
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Bid, 1);
    f.switch_to_funded_trader();
    let ix = f.append(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        600000,
        1,
        2,
        f.order_key(1),
    );
    send(&mut f.svm, &f.owner, &[ix]).unwrap();
    let bob = std::mem::replace(&mut f.owner, alice);
    let bob_position = std::mem::replace(&mut f.position, alice_position);
    let ix = f.cancel(1);
    send(&mut f.svm, &f.owner, &[ix]).unwrap();
    let alice = std::mem::replace(&mut f.owner, bob);
    f.position = bob_position;
    let level = f.level(PredictionOutcome::Yes, OrderSide::Bid, 600000);
    let rent = f.svm.get_account(&level).unwrap().lamports;
    let alice_before = f.svm.get_account(&alice.pubkey()).unwrap().lamports;
    let mut bad = f.cancel(2);
    bad.accounts[10].pubkey = f.owner.pubkey();
    f.reject_cancel(bad, "InvalidPredictionRentRecipient");
    let ix = f.cancel(2);
    send(&mut f.svm, &f.owner, &[ix]).unwrap();
    assert_eq!(
        f.svm.get_account(&alice.pubkey()).unwrap().lamports,
        alice_before + rent
    );
    let p: PredictionPosition = read(&f.svm, f.position);
    assert_eq!((p.collateral_free, p.collateral_locked), (15_000_000, 0));
}

#[test]
fn cancellation_rejects_unauthorized_owners_and_already_closed_orders() {
    let mut f = Fixture::new();
    let alice = f.owner.insecure_clone();
    let alice_position = f.position;
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Bid, 2);
    f.switch_to_funded_trader();
    let ix = f.cancel(1);
    f.reject_cancel(ix, "UnauthorizedPredictionOrderOwner");
    f.owner = alice;
    f.position = alice_position;
    let ix = f.cancel(1);
    send(&mut f.svm, &f.owner, std::slice::from_ref(&ix)).unwrap();
    f.reject_cancel(ix, "PredictionOrderNotOpen");
    let mut order: PredictionOrder = read(&f.svm, f.order_key(2));
    order.status = OrderStatus::Filled;
    let key = f.order_key(2);
    write(&mut f.svm, key, &order);
    let ix = f.cancel(2);
    f.reject_cancel(ix, "PredictionOrderNotOpen");
}

#[test]
fn cancellation_rejects_stale_missing_or_corrupt_fifo_and_unneeded_price_hints() {
    let mut f = Fixture::new();
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Bid, 3);
    for index in [6, 7] {
        let mut ix = f.cancel(2);
        ix.accounts[index].pubkey = outcomia::ID;
        f.reject_cancel(ix, "InvalidPredictionOrderNeighbor");
    }
    let mut ix = f.cancel(1);
    ix.accounts[7].pubkey = f.order_key(3);
    f.reject_cancel(ix, "InvalidPredictionOrderNeighbor");
    for index in [8, 9] {
        let mut ix = f.cancel(2);
        ix.accounts[index].pubkey = f.level(PredictionOutcome::Yes, OrderSide::Bid, 600000);
        f.reject_cancel(ix, "ConstraintDuplicateMutableAccount");
    }
    let mut ix = f.cancel(2);
    ix.accounts[10].pubkey = f.owner.pubkey();
    f.reject_cancel(ix, "InvalidPredictionPriceLevel");
    for mutation in 0..7 {
        let original = f.svm.get_account(&f.order_key(1)).unwrap();
        let mut order: PredictionOrder = read(&f.svm, f.order_key(1));
        match mutation {
            0 => order.next_order = None,
            1 => order.outcome = PredictionOutcome::No,
            2 => order.side = OrderSide::Ask,
            3 => order.price = 500000,
            4 => order.market = Pubkey::new_unique(),
            5 => order.status = OrderStatus::Canceled,
            _ => order.order_id = 100,
        }
        let key = f.order_key(1);
        write(&mut f.svm, key, &order);
        let ix = f.cancel(2);
        f.reject_cancel(ix, "InvalidPredictionOrderNeighbor");
        f.svm.set_account(f.order_key(1), original).unwrap();
    }
    let stale = f.cancel(2);
    let ix = f.cancel(1);
    send(&mut f.svm, &f.owner, &[ix]).unwrap();
    f.reject_cancel(stale, "InvalidPredictionOrderNeighbor");
}

#[test]
fn cancellation_rejects_bad_price_links_rent_accounts_and_ledger_arithmetic() {
    let mut f = Fixture::new();
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Bid, 1);
    let ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        800000,
        1,
        (None, Some(600000)),
    );
    send(&mut f.svm, &f.owner, &[ix]).unwrap();
    let mut ix = f.cancel(1);
    ix.accounts[8].pubkey = outcomia::ID;
    f.reject_cancel(ix, "InvalidPredictionPriceLevel");
    let mut ix = f.cancel(1);
    ix.accounts[10].pubkey = outcomia::ID;
    f.reject_cancel(ix, "InvalidPredictionRentRecipient");
    let neighbor_key = f.level(PredictionOutcome::Yes, OrderSide::Bid, 800000);
    let original = f.svm.get_account(&neighbor_key).unwrap();
    let mut neighbor: PredictionPriceLevel = read(&f.svm, neighbor_key);
    neighbor.worse_price = None;
    write(&mut f.svm, neighbor_key, &neighbor);
    let ix = f.cancel(1);
    f.reject_cancel(ix, "InvalidPredictionPriceLevel");
    f.svm.set_account(neighbor_key, original).unwrap();
    let position = f.svm.get_account(&f.position).unwrap();
    for (free, locked, code) in [
        (u64::MAX, 2_000_000, "FreeBalanceOverflow"),
        (0, 0, "LockedBalanceUnderflow"),
    ] {
        let mut p: PredictionPosition = read(&f.svm, f.position);
        p.collateral_free = free;
        p.collateral_locked = locked;
        write(&mut f.svm, f.position, &p);
        let ix = f.cancel(1);
        f.reject_cancel(ix, code);
        f.svm.set_account(f.position, position.clone()).unwrap();
    }
    let original = f.svm.get_account(&f.order_key(1)).unwrap();
    let mut order: PredictionOrder = read(&f.svm, f.order_key(1));
    order.locked_collateral += 1;
    let key = f.order_key(1);
    write(&mut f.svm, key, &order);
    let ix = f.cancel(1);
    f.reject_cancel(ix, "PredictionOrderAccountingMismatch");
    f.svm.set_account(f.order_key(1), original).unwrap();
    let mut market: PredictionMarket = read(&f.svm, f.market);
    market.open_order_count = 0;
    write(&mut f.svm, f.market, &market);
    let ix = f.cancel(1);
    f.reject_cancel(ix, "PredictionOrderAccountingMismatch");
}

#[test]
fn later_failure_rolls_back_refund_queue_links_level_closure_and_rent() {
    let mut f = Fixture::new();
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Ask, 2);
    let first = f.cancel(1);
    let second = f.cancel(2);
    let level = f.level(PredictionOutcome::Yes, OrderSide::Ask, 600000);
    let before = f.snapshot();
    let level_before = f.svm.get_account(&level);
    let order_before = f.svm.get_account(&f.order_key(1));
    // First unlink succeeds; second uses stale previous_order and aborts the batch.
    assert!(send(&mut f.svm, &f.owner, &[first, second]).is_err());
    assert_eq!(f.snapshot(), before);
    assert_eq!(f.svm.get_account(&level), level_before);
    assert_eq!(f.svm.get_account(&f.order_key(1)), order_before);
    let ix = f.cancel(1);
    send(&mut f.svm, &f.owner, &[ix]).unwrap();
    let last = f.cancel(2);
    let before = f.snapshot();
    let level_before = f.svm.get_account(&level);
    let owner_before = f.svm.get_account(&f.owner.pubkey()).unwrap().lamports;
    let failure = send(&mut f.svm, &f.owner, &[last.clone(), last]).unwrap_err();
    assert_eq!(
        f.svm.get_account(&f.owner.pubkey()).unwrap().lamports,
        owner_before - failure.meta.fee
    );
    assert_eq!(f.snapshot(), before);
    assert_eq!(f.svm.get_account(&level), level_before);
}

#[test]
fn cancellation_refunds_only_the_recorded_unfilled_remainder() {
    // Matching is not implemented yet. Inject a consistent post-partial-fill
    // order/level snapshot to exercise cancellation's future remainder contract;
    // this test does not claim to execute settlement or model the counterparty.
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for side in [OrderSide::Bid, OrderSide::Ask] {
            let mut f = Fixture::new();
            f.seed_queue(outcome, side, 1);
            let key = f.order_key(1);
            let mut order: PredictionOrder = read(&f.svm, key);
            order.remaining_quantity = 1;
            order.locked_collateral = if side == OrderSide::Bid { 600000 } else { 1 };
            let mut level: PredictionPriceLevel = read(&f.svm, order.price_level);
            level.total_remaining_quantity = 1;
            let mut position: PredictionPosition = read(&f.svm, f.position);
            match (outcome, side) {
                (_, OrderSide::Bid) => position.collateral_locked = order.locked_collateral,
                (PredictionOutcome::Yes, OrderSide::Ask) => position.yes_locked = 1,
                (PredictionOutcome::No, OrderSide::Ask) => position.no_locked = 1,
            }
            let free_before = match (outcome, side) {
                (_, OrderSide::Bid) => position.collateral_free,
                (PredictionOutcome::Yes, OrderSide::Ask) => position.yes_free,
                (PredictionOutcome::No, OrderSide::Ask) => position.no_free,
            };
            write(&mut f.svm, key, &order);
            write(&mut f.svm, order.price_level, &level);
            write(&mut f.svm, f.position, &position);
            let custody = f.svm.get_account(&f.vault);
            let ix = f.cancel(1);
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            let position: PredictionPosition = read(&f.svm, f.position);
            let free_after = match (outcome, side) {
                (_, OrderSide::Bid) => position.collateral_free,
                (PredictionOutcome::Yes, OrderSide::Ask) => position.yes_free,
                (PredictionOutcome::No, OrderSide::Ask) => position.no_free,
            };
            assert_eq!(free_after - free_before, order.locked_collateral);
            assert_eq!(f.svm.get_account(&f.vault), custody);
            let order: PredictionOrder = read(&f.svm, key);
            assert_eq!((order.quantity, order.remaining_quantity), (2, 0));
        }
    }
}

#[test]
fn cancellation_rejects_missing_signature_noncanonical_accounts_and_bad_level_totals() {
    let mut f = Fixture::new();
    f.seed_queue(PredictionOutcome::Yes, OrderSide::Bid, 1);
    let payer = Keypair::new();
    f.svm.airdrop(&payer.pubkey(), 2_000_000_000).unwrap();
    let before = f.snapshot();
    let mut unsigned = f.cancel(1);
    unsigned.accounts[0].is_signer = false;
    let failure = send(&mut f.svm, &payer, &[unsigned]).unwrap_err();
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|s| s.contains("AccountNotSigner")),
        "{failure:?}"
    );
    assert_eq!(f.snapshot(), before);
    // A valid serialized account at a different address still fails PDA binding.
    for index in [1, 2, 3, 4, 5] {
        let mut ix = f.cancel(1);
        let fake = Pubkey::new_unique();
        f.svm
            .set_account(fake, f.svm.get_account(&ix.accounts[index].pubkey).unwrap())
            .unwrap();
        ix.accounts[index].pubkey = fake;
        f.reject_cancel(ix, "ConstraintSeeds");
    }
    let level_key = f.level(PredictionOutcome::Yes, OrderSide::Bid, 600000);
    let original = f.svm.get_account(&level_key).unwrap();
    for (count, quantity) in [(0, 2), (1, 0), (1, 3), (2, 2)] {
        let mut level: PredictionPriceLevel = read(&f.svm, level_key);
        level.order_count = count;
        level.total_remaining_quantity = quantity;
        write(&mut f.svm, level_key, &level);
        let ix = f.cancel(1);
        f.reject_cancel(ix, "PredictionOrderAccountingMismatch");
        f.svm.set_account(level_key, original.clone()).unwrap();
    }
}

#[test]
fn sorted_insertion_and_non_best_fifo_append_preserve_all_four_lists_and_backing() {
    let mut f = Fixture::new();
    let vault = f.svm.get_account(&f.vault);
    let fees = f.svm.get_account(&f.fees);
    for outcome in [PredictionOutcome::Yes, PredictionOutcome::No] {
        for side in [OrderSide::Bid, OrderSide::Ask] {
            // Separate bid/ask ranges keep this a non-crossing resting book.
            let prices = if side == OrderSide::Bid {
                [300000, 400000, 200000, 350000]
            } else {
                [700000, 600000, 800000, 650000]
            };
            let book: PredictionOrderBook = read(&f.svm, f.book);
            let ix = f.ix(outcome, side, prices[0], 1, book.next_order_id);
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            let maker_position = f.position;
            let maker_before = f.svm.get_account(&maker_position);
            // An unrelated funded trader may insert without the first trader signing.
            f.switch_to_funded_trader();
            for (price, hints) in [
                (prices[1], (None, Some(prices[0]))),
                (prices[2], (Some(prices[0]), None)),
                (prices[3], (Some(prices[1]), Some(prices[0]))),
            ] {
                let custody_before = f.svm.get_account(&f.vault);
                let market_before: PredictionMarket = read(&f.svm, f.market);
                let balance_before: PredictionPosition = read(&f.svm, f.position);
                let ix = f.insert(outcome, side, price, 1, hints);
                send(&mut f.svm, &f.owner, std::slice::from_ref(&ix)).unwrap();
                assert_eq!(f.svm.get_account(&f.vault), custody_before);
                let after: PredictionMarket = read(&f.svm, f.market);
                assert_eq!(
                    (after.backing_reserve, after.yes_supply, after.no_supply),
                    (
                        market_before.backing_reserve,
                        market_before.yes_supply,
                        market_before.no_supply
                    )
                );
                let balance: PredictionPosition = read(&f.svm, f.position);
                assert_eq!(
                    balance.collateral_free + balance.collateral_locked,
                    balance_before.collateral_free + balance_before.collateral_locked
                );
                assert_eq!(
                    balance.yes_free + balance.yes_locked,
                    balance_before.yes_free + balance_before.yes_locked
                );
                assert_eq!(
                    balance.no_free + balance.no_locked,
                    balance_before.no_free + balance_before.no_locked
                );
                let level: PredictionPriceLevel = read(&f.svm, ix.accounts[4].pubkey);
                let order: PredictionOrder = read(&f.svm, ix.accounts[5].pubkey);
                assert_eq!(
                    (level.first_order, level.last_order),
                    (Some(ix.accounts[5].pubkey), Some(ix.accounts[5].pubkey))
                );
                assert_eq!((level.order_count, level.total_remaining_quantity), (1, 1));
                assert_eq!((level.better_price, level.worse_price), hints);
                assert_eq!((order.previous_order, order.next_order), (None, None));
                assert_eq!(
                    order.locked_collateral,
                    if side == OrderSide::Bid { price } else { 1 }
                );
                assert_eq!(level.rent_payer, f.owner.pubkey());
            }
            assert_eq!(f.svm.get_account(&maker_position), maker_before);
            let sorted = [prices[1], prices[3], prices[0], prices[2]];
            let book: PredictionOrderBook = read(&f.svm, f.book);
            assert_eq!(book.best_price(outcome, side), Some(sorted[0]));
            for (i, price) in sorted.iter().enumerate() {
                let level: PredictionPriceLevel = read(&f.svm, f.level(outcome, side, *price));
                assert_eq!(level.better_price, i.checked_sub(1).map(|j| sorted[j]));
                assert_eq!(level.worse_price, sorted.get(i + 1).copied());
            }
            // The insertion-produced middle level is immediately append-compatible.
            let level: PredictionPriceLevel = read(&f.svm, f.level(outcome, side, prices[3]));
            let ix = f.append(
                outcome,
                side,
                prices[3],
                1,
                book.next_order_id,
                level.last_order.unwrap(),
            );
            send(&mut f.svm, &f.owner, &[ix]).unwrap();
            let level: PredictionPriceLevel = read(&f.svm, f.level(outcome, side, prices[3]));
            assert_eq!((level.order_count, level.total_remaining_quantity), (2, 2));
        }
    }
    assert_eq!(f.svm.get_account(&f.fees), fees);
    // Only the explicit test funding deposits moved vault tokens, never insertion.
    let before = TokenAccount::unpack(&vault.unwrap().data).unwrap().amount;
    let after = TokenAccount::unpack(&f.svm.get_account(&f.vault).unwrap().data)
        .unwrap()
        .amount;
    assert_eq!(after, before + 4 * 20_000_000);
    let market: PredictionMarket = read(&f.svm, f.market);
    assert_eq!(
        (
            market.open_order_count,
            market.yes_supply,
            market.no_supply,
            market.backing_reserve
        ),
        (20, 30, 30, 30_000_000)
    );
    let book: PredictionOrderBook = read(&f.svm, f.book);
    assert_eq!(book.next_order_id, 21);
}

#[test]
fn insertion_rejects_missing_reversed_nonadjacent_and_stale_neighbors_atomically() {
    let mut f = Fixture::new();
    let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
    send(&mut f.svm, &f.owner, &[first]).unwrap();
    for hints in [
        (None, None),
        (Some(600000), None),
        (Some(600000), Some(600000)),
    ] {
        let ix = f.insert(PredictionOutcome::Yes, OrderSide::Bid, 700000, 1, hints);
        f.reject_insert(
            ix,
            if hints.0 == hints.1 && hints.0.is_some() {
                "ConstraintDuplicateMutableAccount"
            } else {
                "InvalidPredictionPriceLevel"
            },
        );
    }
    let stale = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, Some(600000)),
    );
    let next = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        800000,
        1,
        (None, Some(600000)),
    );
    send(&mut f.svm, &f.owner, &[next]).unwrap();
    // Refresh only the order ID to isolate stale adjacency from stale counter.
    let mut stale = stale;
    let fresh = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, Some(600000)),
    );
    stale.data = fresh.data;
    stale.accounts[5] = fresh.accounts[5].clone();
    f.reject_insert(stale, "InvalidPredictionPriceLevel");
    let worst = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        400000,
        1,
        (Some(600000), None),
    );
    send(&mut f.svm, &f.owner, &[worst]).unwrap();
    let skipped = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (Some(800000), Some(400000)),
    );
    f.reject_insert(skipped, "InvalidPredictionPriceLevel");
}

#[test]
fn insertion_rejects_forged_neighbor_identity_links_and_empty_queues() {
    for mutation in 0..10 {
        let mut f = Fixture::new();
        let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
        send(&mut f.svm, &f.owner, &[first]).unwrap();
        let address = f.level(PredictionOutcome::Yes, OrderSide::Bid, 600000);
        let mut level: PredictionPriceLevel = read(&f.svm, address);
        match mutation {
            0 => level.market = Pubkey::new_unique(),
            1 => level.outcome = PredictionOutcome::No,
            2 => level.side = OrderSide::Ask,
            3 => level.price = 500000,
            4 => level.bump = level.bump.wrapping_sub(1),
            5 => level.order_count = 0,
            6 => level.total_remaining_quantity = 0,
            7 => level.first_order = None,
            8 => level.last_order = None,
            _ => level.better_price = Some(800000),
        }
        write(&mut f.svm, address, &level);
        let ix = f.insert(
            PredictionOutcome::Yes,
            OrderSide::Bid,
            700000,
            1,
            (None, Some(600000)),
        );
        f.reject_insert(ix, "InvalidPredictionPriceLevel");
    }
}

#[test]
fn insertion_binds_signed_owner_position_ids_and_every_neighbor_namespace() {
    let mut f = Fixture::new();
    for (id, outcome, side, price) in [
        (1, PredictionOutcome::Yes, OrderSide::Bid, 600000),
        (2, PredictionOutcome::No, OrderSide::Bid, 600000),
        (3, PredictionOutcome::Yes, OrderSide::Ask, 900000),
    ] {
        let ix = f.ix(outcome, side, price, 1, id);
        send(&mut f.svm, &f.owner, &[ix]).unwrap();
    }
    for (outcome, side, price) in [
        (PredictionOutcome::No, OrderSide::Bid, 600000),
        (PredictionOutcome::Yes, OrderSide::Ask, 900000),
    ] {
        let mut ix = f.insert(
            PredictionOutcome::Yes,
            OrderSide::Bid,
            700000,
            1,
            (None, Some(600000)),
        );
        ix.accounts[8].pubkey = f.level(outcome, side, price);
        f.reject_insert(ix, "InvalidPredictionPriceLevel");
    }
    // Even a byte-for-byte valid level at a different address is not canonical.
    let fake = Pubkey::new_unique();
    let original = f.level(PredictionOutcome::Yes, OrderSide::Bid, 600000);
    f.svm
        .set_account(fake, f.svm.get_account(&original).unwrap())
        .unwrap();
    let mut ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, Some(600000)),
    );
    ix.accounts[8].pubkey = fake;
    f.reject_insert(ix, "InvalidPredictionPriceLevel");
    let mut ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, Some(600000)),
    );
    ix.accounts[0].is_signer = false;
    // Another payer signs; otherwise Message promotes its fee payer to signer.
    let payer = Keypair::new();
    f.svm.airdrop(&payer.pubkey(), 2_000_000_000).unwrap();
    let before = f.snapshot();
    let failure = send(&mut f.svm, &payer, &[ix]).unwrap_err();
    assert!(
        failure
            .meta
            .logs
            .iter()
            .any(|s| s.contains("AccountNotSigner")),
        "{failure:?}"
    );
    assert_eq!(f.snapshot(), before);
    let mut position: PredictionPosition = read(&f.svm, f.position);
    let old_owner = position.owner;
    position.owner = Pubkey::new_unique();
    write(&mut f.svm, f.position, &position);
    let ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, Some(600000)),
    );
    f.reject_insert(ix, "PredictionPositionOwnerMismatch");
    position.owner = old_owner;
    write(&mut f.svm, f.position, &position);
    let mut ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, Some(600000)),
    );
    ix.accounts[4].pubkey = f.level(PredictionOutcome::No, OrderSide::Bid, 700000);
    f.reject_insert(ix, "ConstraintSeeds");
    let mut ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, Some(600000)),
    );
    ix.accounts[5].pubkey = outcomia::derive_prediction_order_pda(&outcomia::ID, &f.market, 5).0;
    f.reject_insert(ix, "ConstraintSeeds");
    let mut book: PredictionOrderBook = read(&f.svm, f.book);
    let mut ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, Some(600000)),
    );
    book.next_order_id += 1;
    write(&mut f.svm, f.book, &book);
    f.reject_insert(ix.clone(), "InvalidPredictionOrderId");
    book.next_order_id = u64::MAX;
    write(&mut f.svm, f.book, &book);
    ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, Some(600000)),
    );
    f.reject_insert(ix, "PredictionAccountingOverflow");
}

#[test]
fn insertion_enforces_funding_lifecycle_crossing_counters_and_transaction_rollback() {
    let mut f = Fixture::new();
    let empty = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, None),
    );
    f.reject_insert(empty, "InvalidPredictionPriceLevel");
    let first = f.ix(PredictionOutcome::Yes, OrderSide::Bid, 600000, 1, 1);
    send(&mut f.svm, &f.owner, &[first]).unwrap();
    for (price, qty, code) in [
        (700000, 0, "InvalidPredictionContractQuantity"),
        (700001, 1, "InvalidPredictionOrderPrice"),
        (1000000, 1, "InvalidPredictionOrderPrice"),
        (700000, 1000, "InsufficientFreeBalance"),
        (700000, u64::MAX, "PredictionAccountingOverflow"),
    ] {
        let ix = f.insert(
            PredictionOutcome::Yes,
            OrderSide::Bid,
            price,
            qty,
            (None, Some(600000)),
        );
        f.reject_insert(ix, code);
    }
    let ask = f.ix(PredictionOutcome::Yes, OrderSide::Ask, 700000, 1, 2);
    send(&mut f.svm, &f.owner, &[ask]).unwrap();
    let unfunded = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Ask,
        800000,
        10,
        (Some(700000), None),
    );
    f.reject_insert(unfunded, "InsufficientPredictionPositions");
    let original_position: PredictionPosition = read(&f.svm, f.position);
    let mut overflow: PredictionPosition = read(&f.svm, f.position);
    overflow.collateral_locked = u64::MAX;
    write(&mut f.svm, f.position, &overflow);
    let ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        650000,
        1,
        (None, Some(600000)),
    );
    f.reject_insert(ix, "LockedBalanceOverflow");
    write(&mut f.svm, f.position, &original_position);
    let crossing = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        700000,
        1,
        (None, Some(600000)),
    );
    f.reject_insert(crossing, "PredictionOrderWouldCross");
    let initial: PredictionMarket = read(&f.svm, f.market);
    for status in [
        PredictionStatus::Draft,
        PredictionStatus::Frozen,
        PredictionStatus::Proposed,
        PredictionStatus::Resolved,
    ] {
        let mut market: PredictionMarket = read(&f.svm, f.market);
        market.status = status;
        write(&mut f.svm, f.market, &market);
        let ix = f.insert(
            PredictionOutcome::Yes,
            OrderSide::Bid,
            650000,
            1,
            (None, Some(600000)),
        );
        f.reject_insert(ix, "PredictionOrderUnavailable");
    }
    write(&mut f.svm, f.market, &initial);
    let mut clock = f.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = initial.close_ts;
    f.svm.set_sysvar(&clock);
    let ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        650000,
        1,
        (None, Some(600000)),
    );
    f.reject_insert(ix, "PredictionOrderUnavailable");
    clock.unix_timestamp = 100;
    f.svm.set_sysvar(&clock);
    let mut full: PredictionMarket = read(&f.svm, f.market);
    full.open_order_count = u64::MAX;
    write(&mut f.svm, f.market, &full);
    let ix = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        650000,
        1,
        (None, Some(600000)),
    );
    f.reject_insert(ix, "PredictionAccountingOverflow");
    write(&mut f.svm, f.market, &initial);
    let before = f.snapshot();
    let first = f.insert(
        PredictionOutcome::Yes,
        OrderSide::Bid,
        650000,
        1,
        (None, Some(600000)),
    );
    // Duplicate IDs in the second instruction force rollback after the splice.
    assert!(send(&mut f.svm, &f.owner, &[first.clone(), first.clone()]).is_err());
    assert_eq!(f.snapshot(), before);
    assert!(f.svm.get_account(&first.accounts[4].pubkey).is_none());
    assert!(f.svm.get_account(&first.accounts[5].pubkey).is_none());
    let level: PredictionPriceLevel = read(
        &f.svm,
        f.level(PredictionOutcome::Yes, OrderSide::Bid, 600000),
    );
    assert_eq!(level.better_price, None);
}

#[test]
fn a_non_admin_trader_can_seed_all_four_queues_without_moving_tokens_or_reserves() {
    let mut f = Fixture::new();
    assert!(f
        .svm
        .get_account(
            &Pubkey::find_program_address(&[b"admin", f.owner.pubkey().as_ref()], &outcomia::ID).0
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
