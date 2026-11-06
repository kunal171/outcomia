//! Shared custody and legacy-to-global transfers with actual SPL CPIs.
#![allow(clippy::result_large_err)]
use anchor_lang::{
    prelude::Pubkey,
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
use tidebook::{constants::*, state::*};
const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/tidebook.so"
));
fn pda(seed: &[u8], parts: &[&[u8]]) -> Pubkey {
    let mut seeds = vec![seed];
    seeds.extend_from_slice(parts);
    Pubkey::find_program_address(&seeds, &tidebook::ID).0
}
fn store<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, value: &T) {
    let mut data = Vec::new();
    value.try_serialize(&mut data).expect("serialize fixture");
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
        svm.add_program(tidebook::ID, PROGRAM).expect("program");
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
            tidebook::ID,
            &tidebook::instruction::InitializeAssetBalance {}.data(),
            tidebook::accounts::InitializeAssetBalance {
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
            tidebook::instruction::WithdrawAsset { amount }.data()
        } else {
            tidebook::instruction::DepositAsset { amount }.data()
        };
        Instruction::new_with_bytes(
            tidebook::ID,
            &data,
            tidebook::accounts::TransferAsset {
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
            &tidebook::ID,
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
            tidebook::ID,
            &tidebook::instruction::MigrateSpotAsset { amount }.data(),
            tidebook::accounts::MigrateSpotAsset {
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
