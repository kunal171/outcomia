//! Shared custody and legacy-to-global transfers with actual SPL CPIs.
#![allow(clippy::result_large_err)]
use anchor_lang::{
    prelude::Pubkey,
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenAccount, AccountState, Mint};
use litesvm::LiteSVM;
use outcomia::{constants::*, state::*};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/outcomia.so"
));
fn pda(seed: &[u8], parts: &[&[u8]]) -> Pubkey {
    let mut seeds = vec![seed];
    seeds.extend_from_slice(parts);
    Pubkey::find_program_address(&seeds, &outcomia::ID).0
}
fn store<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, value: &T) {
    let mut data = Vec::new();
    value.try_serialize(&mut data).expect("serialize fixture");
    data.resize(data.len() + 1024, 0);
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
    .expect("store fixture");
}
fn token_account(svm: &mut LiteSVM, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
    let token = TokenAccount {
        mint,
        owner,
        amount,
        delegate: None.into(),
        state: AccountState::Initialized,
        is_native: None.into(),
        delegated_amount: 0,
        close_authority: None.into(),
    };
    let mut data = vec![0; TokenAccount::LEN];
    TokenAccount::pack(token, &mut data).expect("token fixture");
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
    .expect("store token");
}
struct Fixture {
    svm: LiteSVM,
    owner: Keypair,
    mint: Pubkey,
    wallet_token: Pubkey,
    balance: Pubkey,
    vault: Pubkey,
    authority: Pubkey,
}
impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM).expect("program");
        let owner = Keypair::new();
        svm.airdrop(&owner.pubkey(), 10_000_000_000).expect("rent");
        let mint = Pubkey::new_unique();
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: Some(owner.pubkey()).into(),
                supply: 1_000_000_000,
                decimals: 6,
                is_initialized: true,
                freeze_authority: None.into(),
            },
            &mut data,
        )
        .expect("mint fixture");
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
        .expect("store mint");
        let wallet_token = Pubkey::new_unique();
        token_account(&mut svm, wallet_token, mint, owner.pubkey(), 100_000_000);
        let balance = pda(
            ASSET_BALANCE_SEED,
            &[owner.pubkey().as_ref(), mint.as_ref()],
        );
        let vault = pda(ASSET_VAULT_SEED, &[mint.as_ref()]);
        let authority = pda(ASSET_AUTHORITY_SEED, &[mint.as_ref()]);
        Self {
            svm,
            owner,
            mint,
            wallet_token,
            balance,
            vault,
            authority,
        }
    }
    fn send(&mut self, instructions: &[Instruction]) -> bool {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            instructions,
            Some(&self.owner.pubkey()),
            &self.svm.latest_blockhash(),
        );
        self.svm
            .send_transaction(
                VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&self.owner])
                    .expect("sign fixture"),
            )
            .is_ok()
    }
    fn init(&self) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializeAssetBalance {}.data(),
            outcomia::accounts::InitializeAssetBalance {
                owner: self.owner.pubkey(),
                mint: self.mint,
                asset_balance: self.balance,
                vault_authority: self.authority,
                asset_vault: self.vault,
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }
    fn transfer(&self, amount: u64, withdraw: bool) -> Instruction {
        let data = if withdraw {
            outcomia::instruction::WithdrawAsset { amount }.data()
        } else {
            outcomia::instruction::DepositAsset { amount }.data()
        };
        Instruction::new_with_bytes(
            outcomia::ID,
            &data,
            outcomia::accounts::TransferAsset {
                owner: self.owner.pubkey(),
                mint: self.mint,
                asset_balance: self.balance,
                wallet_token: self.wallet_token,
                vault_authority: self.authority,
                asset_vault: self.vault,
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        )
    }
    fn ledger(&self) -> AssetBalance {
        AssetBalance::try_deserialize(
            &mut self
                .svm
                .get_account(&self.balance)
                .expect("ledger")
                .data
                .as_slice(),
        )
        .expect("decode")
    }
    fn tokens(&self, key: Pubkey) -> u64 {
        TokenAccount::unpack(&self.svm.get_account(&key).expect("tokens").data)
            .expect("decode token")
            .amount
    }
    fn legacy(&mut self, base: Pubkey, free: u64, locked: u64) -> (Pubkey, Pubkey, Pubkey) {
        let market = Pubkey::new_unique();
        store(
            &mut self.svm,
            market,
            &Market {
                authority: self.owner.pubkey(),
                base_mint: base,
                quote_mint: self.mint,
                status: MarketStatus::Active,
                next_order_id: 1,
                base_decimals: 9,
                quote_decimals: 6,
                price_tick_size: 1,
                quantity_lot_size: 1,
                best_bid: None,
                best_ask: None,
                open_order_count: u64::from(locked > 0),
                bump: 255,
            },
        );
        let (ledger, bump) = Pubkey::find_program_address(
            &[
                TRADER_BALANCE_SEED,
                market.as_ref(),
                self.owner.pubkey().as_ref(),
            ],
            &outcomia::ID,
        );
        store(
            &mut self.svm,
            ledger,
            &TraderBalance {
                market,
                owner: self.owner.pubkey(),
                base_free: 0,
                base_locked: 0,
                quote_free: free,
                quote_locked: locked,
                bump,
            },
        );
        let vault = pda(VAULT_SEED, &[market.as_ref(), self.mint.as_ref()]);
        let authority = pda(VAULT_AUTHORITY_SEED, &[market.as_ref()]);
        token_account(&mut self.svm, vault, self.mint, authority, free + locked);
        (market, ledger, vault)
    }
    fn migrate(&self, market: Pubkey, ledger: Pubkey, vault: Pubkey, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::MigrateSpotAsset { amount }.data(),
            outcomia::accounts::MigrateSpotAsset {
                owner: self.owner.pubkey(),
                market,
                trader_balance: ledger,
                mint: self.mint,
                asset_balance: self.balance,
                market_authority: pda(VAULT_AUTHORITY_SEED, &[market.as_ref()]),
                market_vault: vault,
                asset_authority: self.authority,
                asset_vault: self.vault,
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        )
    }
}
#[test]
fn deposit_and_withdraw_preserve_global_custody_and_duplicate_init_cannot_reset() {
    let mut f = Fixture::new();
    assert!(f.send(&[f.init(), f.transfer(25_000_000, false)]));
    assert_eq!(f.ledger().free, 25_000_000);
    assert_eq!(f.tokens(f.vault), 25_000_000);
    assert_eq!(f.tokens(f.wallet_token), 75_000_000);
    assert!(!f.send(&[f.init()]));
    assert_eq!(f.ledger().free, 25_000_000);
    assert!(f.send(&[f.transfer(5_000_000, true)]));
    assert_eq!(f.ledger().free, 20_000_000);
    assert_eq!(f.tokens(f.vault), 20_000_000);
    assert_eq!(f.ledger().locked, 0);
}
#[test]
fn multiple_markets_share_one_asset_ledger_and_migration_never_spends_legacy_locks() {
    let mut f = Fixture::new();
    assert!(f.send(&[f.init()]));
    let (a, la, va) = f.legacy(Pubkey::new_unique(), 10_000_000, 3_000_000);
    let (b, lb, vb) = f.legacy(Pubkey::new_unique(), 20_000_000, 0);
    assert!(f.send(&[
        f.migrate(a, la, va, 10_000_000),
        f.migrate(b, lb, vb, 20_000_000)
    ]));
    assert_eq!(f.ledger().free, 30_000_000);
    assert_eq!(f.tokens(f.vault), 30_000_000);
    assert_eq!(f.tokens(va), 3_000_000);
    assert_eq!(f.tokens(vb), 0);
    assert!(!f.send(&[f.migrate(a, la, va, 1)]));
    assert_eq!(f.ledger().free, 30_000_000);
    let old = TraderBalance::try_deserialize(
        &mut f.svm.get_account(&la).expect("legacy").data.as_slice(),
    )
    .expect("decode");
    assert_eq!((old.quote_free, old.quote_locked), (0, 3_000_000));
}
#[test]
fn zero_overspending_and_foreign_destinations_roll_back_atomically() {
    let mut f = Fixture::new();
    assert!(f.send(&[f.init()]));
    assert!(!f.send(&[f.transfer(0, false)]));
    assert!(!f.send(&[f.transfer(0, true)]));
    assert!(!f.send(&[f.transfer(101_000_000, false)]));
    assert_eq!(f.tokens(f.wallet_token), 100_000_000);
    assert!(!f.send(&[f.transfer(5_000_000, false), f.transfer(6_000_000, true)]));
    assert_eq!(f.ledger().free, 0);
    assert_eq!(f.tokens(f.vault), 0);
    let foreign = Pubkey::new_unique();
    token_account(&mut f.svm, f.wallet_token, f.mint, foreign, 100_000_000);
    assert!(!f.send(&[f.transfer(1, false)]));
    assert_eq!(f.ledger().free, 0);
}
#[test]
fn locked_shared_funds_cannot_be_withdrawn_and_overflow_never_moves_tokens() {
    let mut f = Fixture::new();
    assert!(f.send(&[f.init()]));
    let bump = f.ledger().bump;
    store(
        &mut f.svm,
        f.balance,
        &AssetBalance {
            owner: f.owner.pubkey(),
            mint: f.mint,
            free: 1,
            locked: 999,
            bump,
        },
    );
    token_account(&mut f.svm, f.vault, f.mint, f.authority, 1000);
    assert!(!f.send(&[f.transfer(2, true)]));
    assert_eq!(f.tokens(f.vault), 1000);
    store(
        &mut f.svm,
        f.balance,
        &AssetBalance {
            owner: f.owner.pubkey(),
            mint: f.mint,
            free: u64::MAX,
            locked: 0,
            bump,
        },
    );
    assert!(!f.send(&[f.transfer(1, false)]));
    assert_eq!(f.tokens(f.wallet_token), 100_000_000);
}

fn load<T: AccountDeserialize>(f: &Fixture, address: Pubkey) -> T {
    T::try_deserialize(
        &mut f
            .svm
            .get_account(&address)
            .expect("account")
            .data
            .as_slice(),
    )
    .expect("decode")
}
fn ix<T: ToAccountMetas, D: InstructionData>(accounts: T, data: D) -> Instruction {
    Instruction::new_with_bytes(outcomia::ID, &data.data(), accounts.to_account_metas(None))
}
fn cash(f: &mut Fixture, owner: Pubkey, mint: Pubkey, free: u64) -> Pubkey {
    let (key, bump) = Pubkey::find_program_address(
        &[ASSET_BALANCE_SEED, owner.as_ref(), mint.as_ref()],
        &outcomia::ID,
    );
    store(
        &mut f.svm,
        key,
        &AssetBalance {
            owner,
            mint,
            free,
            locked: 0,
            bump,
        },
    );
    key
}
fn shared_spot(f: &mut Fixture, base: Pubkey) -> (Pubkey, Pubkey) {
    let (market, bump) = Pubkey::find_program_address(
        &[MARKET_SEED, base.as_ref(), f.mint.as_ref()],
        &outcomia::ID,
    );
    store(
        &mut f.svm,
        market,
        &Market {
            authority: f.owner.pubkey(),
            base_mint: base,
            quote_mint: f.mint,
            status: MarketStatus::Active,
            next_order_id: 1,
            base_decimals: 0,
            quote_decimals: 6,
            price_tick_size: 1,
            quantity_lot_size: 1,
            best_bid: None,
            best_ask: None,
            open_order_count: 0,
            bump,
        },
    );
    let (book, bump) =
        Pubkey::find_program_address(&[SHARED_BOOK_SEED, market.as_ref()], &outcomia::ID);
    store(
        &mut f.svm,
        book,
        &SharedBook {
            market,
            authority: f.owner.pubkey(),
            kind: MarketKind::Spot,
            base_mint: base,
            quote_mint: f.mint,
            base_decimals: 0,
            quote_decimals: 6,
            price_tick: 1,
            quantity_lot: 1,
            payout_per_contract: 0,
            best_prices: [None; 4],
            next_order_id: 1,
            open_order_count: 0,
            accrued_quote_fees: 0,
            bump,
        },
    );
    (market, book)
}
#[allow(clippy::too_many_arguments)]
fn place(
    f: &Fixture,
    market: Pubkey,
    book: Pubkey,
    base: Pubkey,
    id: u64,
    side: OrderSide,
    price: u64,
    quantity: u64,
    tail: Option<Pubkey>,
) -> Instruction {
    ix(
        outcomia::accounts::PlaceSharedOrder {
            owner: f.owner.pubkey(),
            market,
            book,
            base_balance: Some(base),
            quote_balance: f.balance,
            position: None,
            order: pda(SHARED_ORDER_SEED, &[book.as_ref(), &id.to_le_bytes()]),
            price_level: pda(
                SHARED_LEVEL_SEED,
                &[book.as_ref(), b"spot", side.seed(), &price.to_le_bytes()],
            ),
            tail,
            better_level: None,
            worse_level: None,
            system_program: system_program::ID,
        },
        outcomia::instruction::PlaceSharedOrder {
            outcome: SharedOutcome::Spot,
            side,
            price,
            quantity,
            order_id: id,
        },
    )
}
#[allow(clippy::too_many_arguments)]
fn cancel(
    f: &Fixture,
    book: Pubkey,
    base: Pubkey,
    id: u64,
    side: OrderSide,
    price: u64,
    previous: Option<Pubkey>,
    next: Option<Pubkey>,
    close: bool,
) -> Instruction {
    ix(
        outcomia::accounts::CancelSharedOrder {
            owner: f.owner.pubkey(),
            book,
            base_balance: Some(base),
            quote_balance: f.balance,
            position: None,
            order: pda(SHARED_ORDER_SEED, &[book.as_ref(), &id.to_le_bytes()]),
            price_level: pda(
                SHARED_LEVEL_SEED,
                &[book.as_ref(), b"spot", side.seed(), &price.to_le_bytes()],
            ),
            previous_order: previous,
            next_order: next,
            better_level: None,
            worse_level: None,
            level_rent_recipient: close.then_some(f.owner.pubkey()),
        },
        outcomia::instruction::CancelSharedOrder {},
    )
}

#[test]
fn shared_quote_locks_span_markets_and_cancel_releases_only_its_order() {
    let mut f = Fixture::new();
    assert!(f.send(&[f.init(), f.transfer(1000, false)]));
    let owner = f.owner.pubkey();
    let mint1 = Pubkey::new_unique();
    let mint2 = Pubkey::new_unique();
    let base1 = cash(&mut f, owner, mint1, 10);
    let base2 = cash(&mut f, owner, mint2, 10);
    let (m1, b1) = shared_spot(&mut f, mint1);
    let (m2, b2) = shared_spot(&mut f, mint2);
    assert!(f.send(&[place(&f, m1, b1, base1, 1, OrderSide::Bid, 100, 3, None)]));
    assert!(f.send(&[place(&f, m2, b2, base2, 1, OrderSide::Bid, 100, 4, None)]));
    assert_eq!((f.ledger().free, f.ledger().locked), (300, 700));
    // Cross-market overspending must fail even though each individual order looks affordable.
    assert!(!f.send(&[place(
        &f,
        m1,
        b1,
        base1,
        2,
        OrderSide::Bid,
        100,
        4,
        Some(pda(SHARED_ORDER_SEED, &[b1.as_ref(), &1u64.to_le_bytes()]))
    )]));
    let mut m: Market = load(&f, m1);
    m.status = MarketStatus::Paused;
    store(&mut f.svm, m1, &m);
    assert!(f.send(&[cancel(
        &f,
        b1,
        base1,
        1,
        OrderSide::Bid,
        100,
        None,
        None,
        true
    )]));
    assert_eq!((f.ledger().free, f.ledger().locked), (600, 400));
    assert_eq!(f.tokens(f.vault), 1000);
    assert!(!f.send(&[cancel(
        &f,
        b1,
        base1,
        1,
        OrderSide::Bid,
        100,
        None,
        None,
        true
    )]));
    let order: SharedOrder = load(
        &f,
        pda(SHARED_ORDER_SEED, &[b1.as_ref(), &1u64.to_le_bytes()]),
    );
    assert_eq!(order.remaining_quantity, 3);
    assert!(matches!(order.status, OrderStatus::Canceled));
}

#[test]
fn shared_fifo_settlement_conserves_global_assets_and_fee_claim() {
    let mut f = Fixture::new();
    assert!(f.send(&[f.init(), f.transfer(1000, false)]));
    let owner = f.owner.pubkey();
    let mint = Pubkey::new_unique();
    let base = cash(&mut f, owner, mint, 10);
    let (market, book) = shared_spot(&mut f, mint);
    let o1 = pda(SHARED_ORDER_SEED, &[book.as_ref(), &1u64.to_le_bytes()]);
    let o2 = pda(SHARED_ORDER_SEED, &[book.as_ref(), &2u64.to_le_bytes()]);
    assert!(f.send(&[place(
        &f,
        market,
        book,
        base,
        1,
        OrderSide::Ask,
        100,
        2,
        None
    )]));
    assert!(f.send(&[place(
        &f,
        market,
        book,
        base,
        2,
        OrderSide::Ask,
        100,
        3,
        Some(o1)
    )]));
    let taker = Keypair::new();
    f.svm.airdrop(&taker.pubkey(), 1_000_000_000).unwrap();
    let tb = cash(&mut f, taker.pubkey(), mint, 0);
    let quote = f.mint;
    let tq = cash(&mut f, taker.pubkey(), quote, 1000);
    token_account(&mut f.svm, f.vault, f.mint, f.authority, 2000);
    let base_vault = pda(ASSET_VAULT_SEED, &[mint.as_ref()]);
    token_account(
        &mut f.svm,
        base_vault,
        mint,
        pda(ASSET_AUTHORITY_SEED, &[mint.as_ref()]),
        10,
    );
    let (config, bump) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &outcomia::ID);
    store(
        &mut f.svm,
        config,
        &ProtocolConfig {
            super_admin: owner,
            taker_fee_bps: 100,
            bump,
        },
    );
    let level = pda(
        SHARED_LEVEL_SEED,
        &[book.as_ref(), b"spot", b"ask", &100u64.to_le_bytes()],
    );
    let make = |order, next| {
        ix(
            outcomia::accounts::MatchSharedOrder {
                taker: taker.pubkey(),
                market,
                book,
                protocol_config: config,
                maker_order: order,
                price_level: level,
                maker_base: Some(base),
                maker_quote: f.balance,
                maker_position: None,
                taker_base: Some(tb),
                taker_quote: tq,
                taker_position: None,
                next_order: next,
                worse_level: None,
                level_rent_recipient: None,
            },
            outcomia::instruction::MatchSharedOrder {
                outcome: SharedOutcome::Spot,
                taker_side: OrderSide::Bid,
                limit_price: 120,
                quantity: 2,
            },
        )
    };
    let skipped = make(o2, Some(o1));
    let first = make(o1, Some(o2));
    let send = |f: &mut Fixture, i: Instruction| {
        f.svm.expire_blockhash();
        let msg =
            Message::new_with_blockhash(&[i], Some(&taker.pubkey()), &f.svm.latest_blockhash());
        f.svm
            .send_transaction(
                VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&taker]).unwrap(),
            )
            .is_ok()
    };
    assert!(!send(&mut f, skipped));
    assert!(send(&mut f, first));
    let maker: AssetBalance = load(&f, base);
    let takerb: AssetBalance = load(&f, tb);
    let takerq: AssetBalance = load(&f, tq);
    let root: SharedBook = load(&f, book);
    assert_eq!((maker.free, maker.locked, takerb.free), (5, 3, 2));
    assert_eq!(
        (f.ledger().free, takerq.free, root.accrued_quote_fees),
        (1200, 798, 2)
    );
    assert_eq!(root.open_order_count, 1);
    assert_eq!(
        f.tokens(f.vault),
        f.ledger().free + takerq.free + root.accrued_quote_fees
    );
    assert_eq!(
        f.tokens(base_vault),
        maker.free + maker.locked + takerb.free
    );

    // Verify the remaining FIFO maker can be canceled and global locks return to free.
    assert!(f.send(&[cancel(
        &f,
        book,
        base,
        2,
        OrderSide::Ask,
        100,
        None,
        None,
        true
    )]));
    assert_eq!(load::<AssetBalance>(&f, base).free, 8);
}

fn prediction(f: &mut Fixture) -> (Pubkey, Pubkey) {
    let id = [91; 32];
    let (market, bump) =
        Pubkey::find_program_address(&[PREDICTION_MARKET_SEED, &id], &outcomia::ID);
    let vault = pda(VAULT_SEED, &[market.as_ref(), f.mint.as_ref()]);
    let authority = pda(VAULT_AUTHORITY_SEED, &[market.as_ref()]);
    token_account(&mut f.svm, vault, f.mint, authority, 0);
    store(
        &mut f.svm,
        market,
        &PredictionMarket {
            market_id: id,
            authority: f.owner.pubkey(),
            resolver: f.owner.pubkey(),
            fallback: None,
            collateral_mint: f.mint,
            collateral_vault: vault,
            metadata: Pubkey::new_unique(),
            question_hash: [1; 32],
            rules_hash: [2; 32],
            rules_uri: "ar://rules".into(),
            close_ts: 100,
            earliest_resolution_ts: None,
            resolution_delay_seconds: 10,
            resolution_phase: PredictionResolutionPhase::Primary,
            status: PredictionStatus::Open,
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
    let (position, bump) = Pubkey::find_program_address(
        &[
            PREDICTION_POSITION_SEED,
            market.as_ref(),
            f.owner.pubkey().as_ref(),
        ],
        &outcomia::ID,
    );
    store(
        &mut f.svm,
        position,
        &PredictionPosition {
            market,
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
    let (admin, bump) =
        Pubkey::find_program_address(&[ADMIN_SEED, f.owner.pubkey().as_ref()], &outcomia::ID);
    store(
        &mut f.svm,
        admin,
        &AdminRecord {
            authority: f.owner.pubkey(),
            added_by: f.owner.pubkey(),
            status: AdminStatus::Active,
            bump,
        },
    );
    (market, position)
}
fn pred_custody(
    f: &Fixture,
    market: Pubkey,
    position: Pubkey,
) -> outcomia::accounts::SharedPredictionCustody {
    outcomia::accounts::SharedPredictionCustody {
        owner: f.owner.pubkey(),
        market,
        position,
        mint: f.mint,
        asset_balance: f.balance,
        asset_authority: f.authority,
        asset_vault: f.vault,
        market_authority: pda(VAULT_AUTHORITY_SEED, &[market.as_ref()]),
        market_vault: pda(VAULT_SEED, &[market.as_ref(), f.mint.as_ref()]),
        token_program: anchor_spl::token::ID,
    }
}
fn clock(f: &mut Fixture, now: i64) {
    let mut c = f.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    c.unix_timestamp = now;
    f.svm.set_sysvar(&c);
}
fn propose(
    f: &Fixture,
    market: Pubkey,
    outcome: PredictionResolution,
    correction: bool,
) -> Instruction {
    ix(
        outcomia::accounts::ResolvePrediction {
            resolver: f.owner.pubkey(),
            market,
            admin_record: pda(ADMIN_SEED, &[f.owner.pubkey().as_ref()]),
        },
        outcomia::instruction::ProposePrediction {
            outcome,
            evidence_uri: "ar://evidence".into(),
            evidence_hash: [7; 32],
            correction,
        },
    )
}
fn advance(market: Pubkey, action: u8) -> Instruction {
    ix(
        outcomia::accounts::AdvancePrediction { market },
        outcomia::instruction::AdvancePrediction { action },
    )
}

#[test]
fn prediction_split_resolution_correction_redemption_and_replay_are_conserved() {
    let mut f = Fixture::new();
    clock(&mut f, 1);
    assert!(f.send(&[f.init(), f.transfer(10_000_000, false)]));
    let (market, pos) = prediction(&mut f);
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::SharedCompleteSet {
            quantity: 4,
            split: true
        }
    )]));
    assert_eq!(f.ledger().free, 6_000_000);
    let vault = pred_custody(&f, market, pos).market_vault;
    assert_eq!(f.tokens(vault), 4_000_000);
    assert!(!f.send(&[propose(&f, market, PredictionResolution::Yes, false)]));
    clock(&mut f, 100);
    assert!(f.send(&[propose(&f, market, PredictionResolution::No, false)]));
    assert!(!f.send(&[advance(market, 2)]));
    clock(&mut f, 105);
    assert!(f.send(&[propose(&f, market, PredictionResolution::Yes, true)]));
    clock(&mut f, 110);
    assert!(!f.send(&[advance(market, 2)]));
    clock(&mut f, 115);
    assert!(!f.send(&[propose(&f, market, PredictionResolution::No, true)]));
    // Finalization does not depend on the resolver retaining its admin record.
    let admin = pda(ADMIN_SEED, &[f.owner.pubkey().as_ref()]);
    let mut a: AdminRecord = load(&f, admin);
    a.status = AdminStatus::Disabled;
    store(&mut f.svm, admin, &a);
    assert!(f.send(&[advance(market, 2)]));
    let redeem = ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::RedeemPrediction { yes: 4, no: 4 },
    );
    assert!(f.send(std::slice::from_ref(&redeem)));
    assert!(!f.send(&[redeem]));
    assert_eq!(f.ledger().free, 10_000_000);
    assert_eq!(f.tokens(vault), 0);
    let m: PredictionMarket = load(&f, market);
    assert_eq!((m.yes_supply, m.no_supply, m.backing_reserve), (0, 0, 0));
    assert_eq!(f.tokens(f.vault), f.ledger().free);
}

#[test]
fn configured_fallback_timeout_pays_exact_half_and_cannot_override_proposal() {
    let mut f = Fixture::new();
    clock(&mut f, 1);
    assert!(f.send(&[f.init(), f.transfer(10_000_000, false)]));
    let (market, pos) = prediction(&mut f);
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::SharedCompleteSet {
            quantity: 3,
            split: true
        }
    )]));
    let mut m: PredictionMarket = load(&f, market);
    m.fallback = Some(PredictionFallback {
        resolver: Pubkey::new_unique(),
        available_ts: 120,
        deadline_ts: Some(150),
    });
    store(&mut f.svm, market, &m);
    clock(&mut f, 119);
    assert!(!f.send(&[advance(market, 1)]));
    clock(&mut f, 120);
    assert!(f.send(&[advance(market, 1)]));
    assert!(!f.send(&[propose(&f, market, PredictionResolution::Yes, false)]));
    clock(&mut f, 149);
    assert!(!f.send(&[advance(market, 3)]));
    clock(&mut f, 150);
    assert!(f.send(&[advance(market, 3)]));
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::RedeemPrediction { yes: 1, no: 0 }
    )]));
    assert_eq!(f.ledger().free, 7_500_000);
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::RedeemPrediction { yes: 2, no: 3 }
    )]));
    assert_eq!(f.ledger().free, 10_000_000);
}

#[test]
fn shared_prediction_bid_uses_global_cash_and_cancel_works_after_resolution() {
    let mut f = Fixture::new();
    clock(&mut f, 1);
    assert!(f.send(&[f.init(), f.transfer(10_000_000, false)]));
    let (market, position) = prediction(&mut f);
    let (book, bump) =
        Pubkey::find_program_address(&[SHARED_BOOK_SEED, market.as_ref()], &outcomia::ID);
    store(
        &mut f.svm,
        book,
        &SharedBook {
            market,
            authority: f.owner.pubkey(),
            kind: MarketKind::Prediction,
            base_mint: Pubkey::default(),
            quote_mint: f.mint,
            base_decimals: 0,
            quote_decimals: 6,
            price_tick: 10_000,
            quantity_lot: 1,
            payout_per_contract: 1_000_000,
            best_prices: [None; 4],
            next_order_id: 1,
            open_order_count: 0,
            accrued_quote_fees: 0,
            bump,
        },
    );
    let order = pda(SHARED_ORDER_SEED, &[book.as_ref(), &1u64.to_le_bytes()]);
    let level = pda(
        SHARED_LEVEL_SEED,
        &[book.as_ref(), b"yes", b"bid", &400_000u64.to_le_bytes()],
    );
    let make = |price: u64, quantity: u64| {
        ix(
            outcomia::accounts::PlaceSharedOrder {
                owner: f.owner.pubkey(),
                market,
                book,
                base_balance: None,
                quote_balance: f.balance,
                position: Some(position),
                order,
                price_level: pda(
                    SHARED_LEVEL_SEED,
                    &[book.as_ref(), b"yes", b"bid", &price.to_le_bytes()],
                ),
                tail: None,
                better_level: None,
                worse_level: None,
                system_program: system_program::ID,
            },
            outcomia::instruction::PlaceSharedOrder {
                outcome: SharedOutcome::Yes,
                side: OrderSide::Bid,
                price,
                quantity,
                order_id: 1,
            },
        )
    };
    let invalid = make(405_000u64, 3);
    let valid = make(400_000, 3);
    assert!(!f.send(&[invalid]));
    assert!(f.send(&[valid]));
    assert_eq!((f.ledger().free, f.ledger().locked), (8_800_000, 1_200_000));
    let mut m: PredictionMarket = load(&f, market);
    m.status = PredictionStatus::Resolved;
    m.final_outcome = Some(PredictionResolution::No);
    store(&mut f.svm, market, &m);
    let cancel = ix(
        outcomia::accounts::CancelSharedOrder {
            owner: f.owner.pubkey(),
            book,
            base_balance: None,
            quote_balance: f.balance,
            position: Some(position),
            order,
            price_level: level,
            previous_order: None,
            next_order: None,
            better_level: None,
            worse_level: None,
            level_rent_recipient: Some(f.owner.pubkey()),
        },
        outcomia::instruction::CancelSharedOrder {},
    );
    assert!(f.send(&[cancel]));
    assert_eq!((f.ledger().free, f.ledger().locked), (10_000_000, 0));
}

#[test]
fn redemption_cannot_burn_locked_claims_and_merge_is_exact_before_resolution() {
    let mut f = Fixture::new();
    clock(&mut f, 1);
    assert!(f.send(&[f.init(), f.transfer(10_000_000, false)]));
    let (market, pos) = prediction(&mut f);
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::SharedCompleteSet {
            quantity: 4,
            split: true
        }
    )]));
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::SharedCompleteSet {
            quantity: 1,
            split: false
        }
    )]));
    assert_eq!(f.ledger().free, 7_000_000);
    let mut position: PredictionPosition = load(&f, pos);
    position.yes_free = 1;
    position.yes_locked = 2;
    store(&mut f.svm, pos, &position);
    assert!(!f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::SharedCompleteSet {
            quantity: 2,
            split: false
        }
    )]));
    assert!(!f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::RedeemPrediction { yes: 1, no: 0 }
    )]));
    let mut m: PredictionMarket = load(&f, market);
    m.status = PredictionStatus::Resolved;
    m.final_outcome = Some(PredictionResolution::Yes);
    store(&mut f.svm, market, &m);
    assert!(!f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::RedeemPrediction { yes: 2, no: 0 }
    )]));
    assert_eq!(f.ledger().free, 7_000_000);
    assert_eq!(
        f.tokens(pred_custody(&f, market, pos).market_vault),
        3_000_000
    );
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::RedeemPrediction { yes: 1, no: 3 }
    )]));
    assert_eq!(f.ledger().free, 8_000_000);
    assert_eq!(load::<PredictionPosition>(&f, pos).yes_locked, 2);
    assert!(!f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::SharedCompleteSet {
            quantity: 1,
            split: true
        }
    )]));
}

#[test]
fn resolution_rejects_disabled_or_foreign_admin_bad_evidence_and_unconfigured_timeout() {
    let mut f = Fixture::new();
    let (market, _) = prediction(&mut f);
    clock(&mut f, 100);
    let admin = pda(ADMIN_SEED, &[f.owner.pubkey().as_ref()]);
    let mut record: AdminRecord = load(&f, admin);
    record.status = AdminStatus::Disabled;
    store(&mut f.svm, admin, &record);
    assert!(!f.send(&[propose(&f, market, PredictionResolution::Yes, false)]));
    record.status = AdminStatus::Active;
    store(&mut f.svm, admin, &record);
    let mut m: PredictionMarket = load(&f, market);
    let original = m.resolver;
    m.resolver = Pubkey::new_unique();
    store(&mut f.svm, market, &m);
    assert!(!f.send(&[propose(&f, market, PredictionResolution::Yes, false)]));
    m.resolver = original;
    store(&mut f.svm, market, &m);
    for (uri, hash) in [
        ("ar://", [1; 32]),
        ("https://bad evidence", [1; 32]),
        ("ar://evidence", [0; 32]),
    ] {
        assert!(!f.send(&[ix(
            outcomia::accounts::ResolvePrediction {
                resolver: f.owner.pubkey(),
                market,
                admin_record: admin
            },
            outcomia::instruction::ProposePrediction {
                outcome: PredictionResolution::Yes,
                evidence_uri: uri.into(),
                evidence_hash: hash,
                correction: false
            }
        )]));
    }
    assert!(!f.send(&[advance(market, 3)]));
    assert!(!f.send(&[advance(market, 1)]));
    assert!(f.send(&[propose(&f, market, PredictionResolution::Yes, false)]));
    assert!(!f.send(&[propose(&f, market, PredictionResolution::No, false)]));
    assert!(!f.send(&[advance(market, 3)]));
}

#[test]
fn shared_book_requires_active_creator_and_empty_shutdown() {
    let mut f = Fixture::new();
    let (market, book) = shared_spot(&mut f, Pubkey::new_unique());
    f.svm.set_account(book, Account::default()).unwrap();
    let owner = f.owner.pubkey();
    let (admin, bump) = Pubkey::find_program_address(&[ADMIN_SEED, owner.as_ref()], &outcomia::ID);
    store(
        &mut f.svm,
        admin,
        &AdminRecord {
            authority: owner,
            added_by: owner,
            status: AdminStatus::Disabled,
            bump,
        },
    );
    let initialize = ix(
        outcomia::accounts::InitializeSharedBook {
            authority: owner,
            admin_record: admin,
            market,
            book,
            system_program: system_program::ID,
        },
        outcomia::instruction::InitializeSharedBook {
            kind: MarketKind::Spot,
        },
    );
    assert!(!f.send(std::slice::from_ref(&initialize)));
    store(
        &mut f.svm,
        admin,
        &AdminRecord {
            authority: owner,
            added_by: owner,
            status: AdminStatus::Active,
            bump,
        },
    );
    assert!(f.send(std::slice::from_ref(&initialize)));
    assert!(!f.send(&[initialize]));
    let close = ix(
        outcomia::accounts::CloseSharedBook {
            authority: owner,
            admin_record: admin,
            market,
            book,
        },
        outcomia::instruction::CloseSharedBook {},
    );
    assert!(!f.send(std::slice::from_ref(&close))); // source must be paused even if root is empty
    let mut m: Market = load(&f, market);
    m.status = MarketStatus::Paused;
    store(&mut f.svm, market, &m);
    let mut b: SharedBook = load(&f, book);
    b.accrued_quote_fees = 1;
    store(&mut f.svm, book, &b);
    assert!(!f.send(std::slice::from_ref(&close)));
    b.accrued_quote_fees = 0;
    store(&mut f.svm, book, &b);
    assert!(f.send(&[close]));
    assert!(f.svm.get_account(&book).is_none_or(|a| a.lamports == 0));
}

#[test]
fn shared_prediction_trade_then_both_wallets_redeem_without_spending_legacy_cash() {
    let mut f = Fixture::new();
    clock(&mut f, 1);
    assert!(f.send(&[f.init(), f.transfer(10_000_000, false)]));
    let (market, pos) = prediction(&mut f);
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::SharedCompleteSet {
            quantity: 4,
            split: true
        }
    )]));
    // Legacy cash shares the physical question vault but is not payout backing.
    let custody = pred_custody(&f, market, pos);
    assert!(f.send(&[ix(
        outcomia::accounts::DepositPredictionCollateral {
            owner: f.owner.pubkey(),
            market,
            position: pos,
            collateral_mint: f.mint,
            source: f.wallet_token,
            vault_authority: custody.market_authority,
            collateral_vault: custody.market_vault,
            token_program: anchor_spl::token::ID
        },
        outcomia::instruction::DepositPredictionCollateral { amount: 2_000_000 }
    )]));
    let owner = f.owner.pubkey();
    let admin = pda(ADMIN_SEED, &[owner.as_ref()]);
    let book = pda(SHARED_BOOK_SEED, &[market.as_ref()]);
    assert!(f.send(&[ix(
        outcomia::accounts::InitializeSharedBook {
            authority: owner,
            admin_record: admin,
            market,
            book,
            system_program: system_program::ID
        },
        outcomia::instruction::InitializeSharedBook {
            kind: MarketKind::Prediction
        }
    )]));
    let order = pda(SHARED_ORDER_SEED, &[book.as_ref(), &1u64.to_le_bytes()]);
    let level = pda(
        SHARED_LEVEL_SEED,
        &[book.as_ref(), b"yes", b"ask", &400_000u64.to_le_bytes()],
    );
    assert!(f.send(&[ix(
        outcomia::accounts::PlaceSharedOrder {
            owner,
            market,
            book,
            base_balance: None,
            quote_balance: f.balance,
            position: Some(pos),
            order,
            price_level: level,
            tail: None,
            better_level: None,
            worse_level: None,
            system_program: system_program::ID
        },
        outcomia::instruction::PlaceSharedOrder {
            outcome: SharedOutcome::Yes,
            side: OrderSide::Ask,
            price: 400_000,
            quantity: 2,
            order_id: 1
        }
    )]));
    let taker = Keypair::new();
    f.svm.airdrop(&taker.pubkey(), 1_000_000_000).unwrap();
    let mint = f.mint;
    let tq = cash(&mut f, taker.pubkey(), mint, 3_000_000);
    token_account(&mut f.svm, f.vault, f.mint, f.authority, 9_000_000);
    let (tp, bump) = Pubkey::find_program_address(
        &[
            PREDICTION_POSITION_SEED,
            market.as_ref(),
            taker.pubkey().as_ref(),
        ],
        &outcomia::ID,
    );
    store(
        &mut f.svm,
        tp,
        &PredictionPosition {
            market,
            owner: taker.pubkey(),
            collateral_free: 0,
            collateral_locked: 0,
            yes_free: 0,
            yes_locked: 0,
            no_free: 0,
            no_locked: 0,
            bump,
        },
    );
    let (config, bump) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &outcomia::ID);
    store(
        &mut f.svm,
        config,
        &ProtocolConfig {
            super_admin: owner,
            taker_fee_bps: 100,
            bump,
        },
    );
    let matching = ix(
        outcomia::accounts::MatchSharedOrder {
            taker: taker.pubkey(),
            market,
            book,
            protocol_config: config,
            maker_order: order,
            price_level: level,
            maker_base: None,
            maker_quote: f.balance,
            maker_position: Some(pos),
            taker_base: None,
            taker_quote: tq,
            taker_position: Some(tp),
            next_order: None,
            worse_level: None,
            level_rent_recipient: Some(owner),
        },
        outcomia::instruction::MatchSharedOrder {
            outcome: SharedOutcome::Yes,
            taker_side: OrderSide::Bid,
            limit_price: 500_000,
            quantity: 2,
        },
    );
    let send = |f: &mut Fixture, i: Instruction| {
        f.svm.expire_blockhash();
        let msg =
            Message::new_with_blockhash(&[i], Some(&taker.pubkey()), &f.svm.latest_blockhash());
        f.svm
            .send_transaction(
                VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&taker]).unwrap(),
            )
            .is_ok()
    };
    assert!(send(&mut f, matching));
    assert_eq!(load::<PredictionPosition>(&f, tp).yes_free, 2);
    assert_eq!(
        load::<PredictionMarket>(&f, market).backing_reserve,
        4_000_000
    );
    clock(&mut f, 100);
    assert!(f.send(&[propose(&f, market, PredictionResolution::Yes, false)]));
    clock(&mut f, 110);
    assert!(f.send(&[advance(market, 2)]));
    let mut custody = pred_custody(&f, market, tp);
    custody.owner = taker.pubkey();
    custody.asset_balance = tq;
    assert!(send(
        &mut f,
        ix(
            custody,
            outcomia::instruction::RedeemPrediction { yes: 2, no: 0 }
        )
    ));
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::RedeemPrediction { yes: 2, no: 4 }
    )]));
    assert_eq!(
        f.tokens(pred_custody(&f, market, pos).market_vault),
        2_000_000
    );
    assert_eq!(
        load::<PredictionPosition>(&f, pos).collateral_free,
        2_000_000
    );
    assert_eq!(load::<PredictionMarket>(&f, market).backing_reserve, 0);
    assert_eq!(
        f.tokens(f.vault),
        f.ledger().free
            + load::<AssetBalance>(&f, tq).free
            + load::<SharedBook>(&f, book).accrued_quote_fees
    );
    assert_eq!(
        (f.ledger().free, load::<AssetBalance>(&f, tq).free),
        (8_800_000, 4_192_000)
    );
}

#[test]
fn shared_bid_partial_fill_and_cancellation_preserve_other_cash_and_fees() {
    let mut f = Fixture::new();
    assert!(f.send(&[f.init(), f.transfer(1000, false)]));
    let owner = f.owner.pubkey();
    let mint = Pubkey::new_unique();
    let base = cash(&mut f, owner, mint, 0);
    let (market, book) = shared_spot(&mut f, mint);
    assert!(f.send(&[place(
        &f,
        market,
        book,
        base,
        1,
        OrderSide::Bid,
        100,
        3,
        None
    )]));
    let taker = Keypair::new();
    f.svm.airdrop(&taker.pubkey(), 1_000_000_000).unwrap();
    let tb = cash(&mut f, taker.pubkey(), mint, 2);
    let quote = f.mint;
    let tq = cash(&mut f, taker.pubkey(), quote, 0);
    let (config, bump) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &outcomia::ID);
    store(
        &mut f.svm,
        config,
        &ProtocolConfig {
            super_admin: owner,
            taker_fee_bps: 100,
            bump,
        },
    );
    let order = pda(SHARED_ORDER_SEED, &[book.as_ref(), &1u64.to_le_bytes()]);
    let level = pda(
        SHARED_LEVEL_SEED,
        &[book.as_ref(), b"spot", b"bid", &100u64.to_le_bytes()],
    );
    let instruction = ix(
        outcomia::accounts::MatchSharedOrder {
            taker: taker.pubkey(),
            market,
            book,
            protocol_config: config,
            maker_order: order,
            price_level: level,
            maker_base: Some(base),
            maker_quote: f.balance,
            maker_position: None,
            taker_base: Some(tb),
            taker_quote: tq,
            taker_position: None,
            next_order: None,
            worse_level: None,
            level_rent_recipient: None,
        },
        outcomia::instruction::MatchSharedOrder {
            outcome: SharedOutcome::Spot,
            taker_side: OrderSide::Ask,
            limit_price: 90,
            quantity: 1,
        },
    );
    let msg = Message::new_with_blockhash(
        &[instruction],
        Some(&taker.pubkey()),
        &f.svm.latest_blockhash(),
    );
    let result = f.svm.send_transaction(
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&taker]).unwrap(),
    );
    assert!(result.is_ok(), "{result:?}");
    assert_eq!((f.ledger().free, f.ledger().locked), (700, 200));
    assert_eq!(load::<SharedOrder>(&f, order).remaining_quantity, 2);
    assert_eq!(load::<AssetBalance>(&f, tq).free, 99);
    assert!(f.send(&[cancel(
        &f,
        book,
        base,
        1,
        OrderSide::Bid,
        100,
        None,
        None,
        true
    )]));
    assert_eq!((f.ledger().free, f.ledger().locked), (900, 0));
    assert_eq!(load::<AssetBalance>(&f, base).free, 1);
    let withdraw = |amount| {
        ix(
            outcomia::accounts::WithdrawSharedFees {
                super_admin: owner,
                protocol_config: config,
                book,
                mint: quote,
                destination: f.wallet_token,
                vault_authority: f.authority,
                asset_vault: f.vault,
                token_program: anchor_spl::token::ID,
            },
            outcomia::instruction::WithdrawSharedFees { amount },
        )
    };
    let excess = withdraw(2);
    let earned = withdraw(1);
    assert!(!f.send(&[excess]));
    assert!(f.send(&[earned]));
    assert_eq!(f.tokens(f.vault), 999);
    assert_eq!(
        f.tokens(f.vault),
        f.ledger().free + load::<AssetBalance>(&f, tq).free
    );
}

#[test]
fn shared_sorted_insertion_and_middle_level_cancellation_repair_both_links() {
    use anchor_lang::solana_program::instruction::AccountMeta;
    let mut f = Fixture::new();
    assert!(f.send(&[f.init()]));
    let owner = f.owner.pubkey();
    let mint = Pubkey::new_unique();
    let base = cash(&mut f, owner, mint, 20);
    let (market, book) = shared_spot(&mut f, mint);
    let level = |price: u64| {
        pda(
            SHARED_LEVEL_SEED,
            &[book.as_ref(), b"spot", b"ask", &price.to_le_bytes()],
        )
    };
    assert!(f.send(&[place(
        &f,
        market,
        book,
        base,
        1,
        OrderSide::Ask,
        100,
        2,
        None
    )]));
    let mut worse = place(&f, market, book, base, 2, OrderSide::Ask, 120, 2, None);
    worse.accounts[9] = AccountMeta::new(level(100), false);
    assert!(f.send(&[worse]));
    let mut middle = place(&f, market, book, base, 3, OrderSide::Ask, 110, 2, None);
    middle.accounts[9] = AccountMeta::new(level(120), false);
    middle.accounts[10] = AccountMeta::new(level(100), false);
    assert!(!f.send(std::slice::from_ref(&middle)));
    middle.accounts[9] = AccountMeta::new(level(100), false);
    middle.accounts[10] = AccountMeta::new(level(120), false);
    assert!(f.send(&[middle]));
    assert_eq!(
        load::<SharedPriceLevel>(&f, level(100)).worse_price,
        Some(110)
    );
    let mut remove = cancel(&f, book, base, 3, OrderSide::Ask, 110, None, None, true);
    remove.accounts[9] = AccountMeta::new(level(100), false);
    remove.accounts[10] = AccountMeta::new(level(120), false);
    assert!(f.send(&[remove]));
    assert_eq!(
        load::<SharedPriceLevel>(&f, level(100)).worse_price,
        Some(120)
    );
    assert_eq!(
        load::<SharedPriceLevel>(&f, level(120)).better_price,
        Some(100)
    );
    assert_eq!(load::<SharedBook>(&f, book).best_prices[1], Some(100));
    assert_eq!(load::<AssetBalance>(&f, base).locked, 4);
}

#[test]
fn active_fallback_resolver_can_propose_no_and_deadline_cannot_override_it() {
    let mut f = Fixture::new();
    clock(&mut f, 1);
    assert!(f.send(&[f.init(), f.transfer(1_000_000, false)]));
    let (market, pos) = prediction(&mut f);
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::SharedCompleteSet {
            quantity: 1,
            split: true
        }
    )]));
    let fallback = Keypair::new();
    f.svm.airdrop(&fallback.pubkey(), 1_000_000_000).unwrap();
    let (admin, bump) =
        Pubkey::find_program_address(&[ADMIN_SEED, fallback.pubkey().as_ref()], &outcomia::ID);
    store(
        &mut f.svm,
        admin,
        &AdminRecord {
            authority: fallback.pubkey(),
            added_by: f.owner.pubkey(),
            status: AdminStatus::Active,
            bump,
        },
    );
    let mut m: PredictionMarket = load(&f, market);
    m.fallback = Some(PredictionFallback {
        resolver: fallback.pubkey(),
        available_ts: 120,
        deadline_ts: Some(150),
    });
    store(&mut f.svm, market, &m);
    clock(&mut f, 120);
    assert!(f.send(&[advance(market, 1)]));
    let instruction = ix(
        outcomia::accounts::ResolvePrediction {
            resolver: fallback.pubkey(),
            market,
            admin_record: admin,
        },
        outcomia::instruction::ProposePrediction {
            outcome: PredictionResolution::No,
            evidence_uri: "https://example.org/evidence".into(),
            evidence_hash: [9; 32],
            correction: false,
        },
    );
    let msg = Message::new_with_blockhash(
        &[instruction],
        Some(&fallback.pubkey()),
        &f.svm.latest_blockhash(),
    );
    assert!(f
        .svm
        .send_transaction(
            VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&fallback]).unwrap()
        )
        .is_ok());
    clock(&mut f, 150);
    assert!(!f.send(&[advance(market, 3)]));
    assert!(f.send(&[advance(market, 2)]));
    assert!(f.send(&[ix(
        pred_custody(&f, market, pos),
        outcomia::instruction::RedeemPrediction { yes: 1, no: 1 }
    )]));
    assert_eq!(f.ledger().free, 1_000_000);
    assert_eq!(load::<PredictionMarket>(&f, market).backing_reserve, 0);
}
