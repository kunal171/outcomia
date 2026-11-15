//! Local SBF execution with real SPL CPIs. Fixtures provide mint/admin setup;
//! every market, position, deposit, split and merge uses actual instructions.
#![allow(clippy::result_large_err)]
use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::{
    self,
    state::{Account as TokenAccount, AccountState, Mint},
};
use litesvm::{types::TransactionResult, LiteSVM};
use outcomia::{constants::*, state::*};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
mod support;
use support::events::single_event;
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
    value
        .try_serialize(&mut data)
        .expect("fixture serialization");
    if let Some(old) = svm.get_account(&key) {
        data.resize(old.data.len().max(data.len()), 0);
    }
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
    .expect("store state");
}
struct Fixture {
    svm: LiteSVM,
    admin: Keypair,
    owner: Keypair,
    attacker: Keypair,
    mint: Pubkey,
    wallet: Pubkey,
    id: [u8; 32],
}
impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM).expect("program");
        let admin = Keypair::new();
        let owner = Keypair::new();
        let attacker = Keypair::new();
        for party in [&admin, &owner, &attacker] {
            svm.airdrop(&party.pubkey(), 2_000_000_000).expect("rent");
        }
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = 100;
        svm.set_sysvar(&clock);
        let mint = Pubkey::new_unique();
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: Some(admin.pubkey()).into(),
                supply: 100_000_000,
                decimals: 6,
                is_initialized: true,
                freeze_authority: Some(admin.pubkey()).into(),
            },
            &mut data,
        )
        .expect("mint");
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
        let wallet = Pubkey::new_unique();
        let mut data = vec![0; TokenAccount::LEN];
        TokenAccount::pack(
            TokenAccount {
                mint,
                owner: owner.pubkey(),
                amount: 100_000_000,
                delegate: None.into(),
                state: AccountState::Initialized,
                is_native: None.into(),
                delegated_amount: 0,
                close_authority: None.into(),
            },
            &mut data,
        )
        .expect("wallet");
        svm.set_account(
            wallet,
            Account {
                lamports: svm.minimum_balance_for_rent_exemption(data.len()),
                data,
                owner: anchor_spl::token::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("store wallet");
        let mut f = Self {
            svm,
            admin,
            owner,
            attacker,
            mint,
            wallet,
            id: [31; 32],
        };
        f.admin_status(AdminStatus::Active);
        f
    }
    fn market_key(&self) -> Pubkey {
        pda(MULTI_OUTCOME_MARKET_SEED, &[&self.id])
    }
    fn position_key(&self) -> Pubkey {
        pda(
            MULTI_OUTCOME_POSITION_SEED,
            &[self.market_key().as_ref(), self.owner.pubkey().as_ref()],
        )
    }
    fn reserve(&self) -> Pubkey {
        pda(
            VAULT_SEED,
            &[self.market_key().as_ref(), self.mint.as_ref()],
        )
    }
    fn global(&self) -> Pubkey {
        pda(ASSET_VAULT_SEED, &[self.mint.as_ref()])
    }
    fn balance_key(&self) -> Pubkey {
        pda(
            ASSET_BALANCE_SEED,
            &[self.owner.pubkey().as_ref(), self.mint.as_ref()],
        )
    }
    fn metadata(&self) -> Pubkey {
        pda(MARKET_METADATA_SEED, &[self.market_key().as_ref()])
    }
    fn admin_status(&mut self, status: AdminStatus) {
        let key = pda(ADMIN_SEED, &[self.admin.pubkey().as_ref()]);
        let bump = Pubkey::find_program_address(
            &[ADMIN_SEED, self.admin.pubkey().as_ref()],
            &outcomia::ID,
        )
        .1;
        store(
            &mut self.svm,
            key,
            &AdminRecord {
                authority: self.admin.pubkey(),
                added_by: self.admin.pubkey(),
                status,
                bump,
            },
        );
    }
    fn terms(&self, count: u8) -> MultiOutcomeTerms {
        MultiOutcomeTerms {
            resolver: self.admin.pubkey(),
            fallback: None,
            outcome_labels: (0..count).map(|i| format!("Candidate {i}")).collect(),
            question_hash: [1; 32],
            rules_hash: [2; 32],
            rules_uri: "ar://rules".into(),
            close_ts: 200,
            earliest_resolution_ts: None,
            resolution_delay_seconds: 10,
            payout_per_contract: 1_000_000,
            price_tick: 10_000,
            quantity_lot: u64::from(count),
        }
    }
    fn creation(&self, terms: MultiOutcomeTerms) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializeMultiOutcomeMarket {
                market_id: self.id,
                terms,
                display_name: "Which candidate wins?".into(),
                collateral_symbol: "tUSDC".into(),
            }
            .data(),
            outcomia::accounts::InitializeMultiOutcomeMarket {
                authority: self.admin.pubkey(),
                admin_record: pda(ADMIN_SEED, &[self.admin.pubkey().as_ref()]),
                market: self.market_key(),
                collateral_mint: self.mint,
                vault_authority: pda(VAULT_AUTHORITY_SEED, &[self.market_key().as_ref()]),
                collateral_vault: self.reserve(),
                market_metadata: self.metadata(),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }
    fn manage(&self, open: bool) -> Instruction {
        let data = if open {
            outcomia::instruction::OpenMultiOutcomeMarket {}.data()
        } else {
            outcomia::instruction::CloseMultiOutcomeTrading {}.data()
        };
        Instruction::new_with_bytes(
            outcomia::ID,
            &data,
            outcomia::accounts::ManageMultiOutcomeMarket {
                authority: self.admin.pubkey(),
                market: self.market_key(),
                admin_record: pda(ADMIN_SEED, &[self.admin.pubkey().as_ref()]),
            }
            .to_account_metas(None),
        )
    }
    fn position_init(&self) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializeMultiOutcomePosition {}.data(),
            outcomia::accounts::InitializeMultiOutcomePosition {
                owner: self.owner.pubkey(),
                market: self.market_key(),
                position: self.position_key(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }
    fn balance_init(&self) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializeAssetBalance {}.data(),
            outcomia::accounts::InitializeAssetBalance {
                owner: self.owner.pubkey(),
                mint: self.mint,
                asset_balance: self.balance_key(),
                vault_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                asset_vault: self.global(),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }
    fn asset_transfer(&self, amount: u64, withdraw: bool) -> Instruction {
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
                asset_balance: self.balance_key(),
                wallet_token: self.wallet,
                vault_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                asset_vault: self.global(),
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        )
    }
    fn complete(&self, q: u64, split: bool) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::MultiOutcomeCompleteSet { quantity: q, split }.data(),
            outcomia::accounts::MultiOutcomeCustody {
                owner: self.owner.pubkey(),
                market: self.market_key(),
                position: self.position_key(),
                mint: self.mint,
                asset_balance: self.balance_key(),
                asset_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                asset_vault: self.global(),
                market_authority: pda(VAULT_AUTHORITY_SEED, &[self.market_key().as_ref()]),
                market_vault: self.reserve(),
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        )
    }
    fn transaction(&self, ix: Instruction) -> VersionedTransaction {
        let msg = Message::new_with_blockhash(
            &[ix],
            Some(&self.admin.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let keys = &msg.account_keys[..usize::from(msg.header.num_required_signatures)];
        let signers: Vec<_> = [&self.admin, &self.owner, &self.attacker]
            .into_iter()
            .filter(|s| keys.contains(&s.pubkey()))
            .collect();
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).expect("sign")
    }
    fn send(&mut self, ix: Instruction) -> TransactionResult {
        self.svm.expire_blockhash();
        let tx = self.transaction(ix);
        self.svm.send_transaction(tx)
    }
    fn read<T: AccountDeserialize>(&self, key: Pubkey) -> T {
        T::try_deserialize(&mut self.svm.get_account(&key).expect("account").data.as_slice())
            .expect("decode")
    }
    fn market(&self) -> MultiOutcomeMarket {
        self.read(self.market_key())
    }
    fn position(&self) -> MultiOutcomePosition {
        self.read(self.position_key())
    }
    fn balance(&self) -> AssetBalance {
        self.read(self.balance_key())
    }
    fn tokens(&self, key: Pubkey) -> u64 {
        TokenAccount::unpack(&self.svm.get_account(&key).expect("token").data)
            .expect("unpack")
            .amount
    }
    fn setup(&mut self, count: u8, deposit: u64) {
        self.send(self.creation(self.terms(count))).expect("create");
        self.send(self.position_init()).expect("position");
        self.send(self.balance_init()).expect("balance");
        if deposit > 0 {
            self.send(self.asset_transfer(deposit, false))
                .expect("deposit");
        }
        self.send(self.manage(true)).expect("open");
    }
    fn snapshot(&self) -> Vec<(Pubkey, Option<Account>)> {
        [
            self.market_key(),
            self.position_key(),
            self.balance_key(),
            self.global(),
            self.reserve(),
            self.wallet,
            self.metadata(),
        ]
        .into_iter()
        .map(|k| (k, self.svm.get_account(&k)))
        .collect()
    }
    fn reject(&mut self, ix: Instruction, code: Option<&str>) {
        let before = self.snapshot();
        let failure = self.send(ix).expect_err("must reject");
        if let Some(code) = code {
            assert!(
                failure
                    .meta
                    .logs
                    .iter()
                    .any(|l| l.contains(&format!("Error Code: {code}"))),
                "{failure:?}"
            );
        }
        assert_eq!(self.snapshot(), before);
    }
}

#[test]
fn ordinary_owner_deposits_splits_merges_and_withdraws_with_exact_token_conservation() {
    let mut f = Fixture::new();
    let created = f.send(f.creation(f.terms(3)));
    created.as_ref().expect("create");
    assert_eq!(
        single_event::<outcomia::MultiOutcomeMarketInitializedEvent>(&created).outcome_count,
        3
    );
    assert_eq!(f.market().status, PredictionStatus::Draft);
    assert_eq!(f.market().supplies, [0; 8]);
    assert_eq!(
        f.svm
            .get_account(&f.market_key())
            .expect("market")
            .data
            .len(),
        1448
    );
    let opened = f.send(f.manage(true));
    assert_eq!(
        single_event::<outcomia::MultiOutcomeMarketStatusEvent>(&opened).status,
        PredictionStatus::Open
    );
    let initialized = f.send(f.position_init());
    assert_eq!(
        single_event::<outcomia::MultiOutcomePositionInitializedEvent>(&initialized).owner,
        f.owner.pubkey()
    );
    f.send(f.balance_init()).expect("balance");
    f.send(f.asset_transfer(9_000_000, false)).expect("deposit");
    let result = f.send(f.complete(6, true));
    let event = single_event::<outcomia::MultiOutcomeCompleteSetEvent>(&result);
    assert_eq!(
        (
            event.quantity,
            event.collateral_atoms,
            event.backing_reserve,
            event.split
        ),
        (6, 6_000_000, 6_000_000, true)
    );
    assert_eq!(f.position().free, [6, 6, 6, 0, 0, 0, 0, 0]);
    assert_eq!(f.market().supplies, f.position().free);
    assert_eq!(f.balance().free, 3_000_000);
    assert_eq!(f.tokens(f.global()), 3_000_000);
    assert_eq!(f.tokens(f.reserve()), 6_000_000);
    f.send(f.complete(3, false)).expect("partial merge");
    assert_eq!(f.position().free, [3, 3, 3, 0, 0, 0, 0, 0]);
    let result = f.send(f.complete(3, false));
    assert!(!single_event::<outcomia::MultiOutcomeCompleteSetEvent>(&result).split);
    f.send(f.asset_transfer(9_000_000, true)).expect("withdraw");
    assert_eq!(f.tokens(f.wallet), 100_000_000);
    assert_eq!(f.tokens(f.global()), 0);
    assert_eq!(f.tokens(f.reserve()), 0);
    assert_eq!(f.balance().free, 0);
    assert_eq!(f.position().free, [0; 8]);
    assert_eq!(f.market().backing_reserve, 0);
}

#[test]
fn creation_rejects_invalid_terms_mint_payout_resolver_and_disabled_admin_atomically() {
    for failure in 0..5 {
        let mut f = Fixture::new();
        let mut terms = f.terms(3);
        let code = match failure {
            0 => {
                terms.quantity_lot = 1;
                "InvalidMultiOutcomeLot"
            }
            1 => {
                terms.payout_per_contract = 2_000_000;
                "InvalidMultiOutcomePayout"
            }
            2 => {
                terms.resolver = f.owner.pubkey();
                "PredictionCreatorMustResolve"
            }
            3 => {
                terms.outcome_labels[1] = "Candidate 0".into();
                "InvalidMultiOutcomeLabel"
            }
            _ => {
                f.admin_status(AdminStatus::Disabled);
                "AdminDisabled"
            }
        };
        f.reject(f.creation(terms), Some(code));
        assert!(f.svm.get_account(&f.market_key()).is_none());
        assert!(f.svm.get_account(&f.reserve()).is_none());
        assert!(f.svm.get_account(&f.metadata()).is_none());
    }
}

#[test]
fn duplicate_initialization_never_resets_a_funded_market_or_position() {
    let mut f = Fixture::new();
    f.setup(3, 9_000_000);
    f.send(f.complete(3, true)).expect("split");
    f.reject(f.creation(f.terms(3)), None);
    f.reject(f.position_init(), None);
    assert_eq!(f.market().backing_reserve, 3_000_000);
    assert_eq!(f.position().free, [3, 3, 3, 0, 0, 0, 0, 0]);
}

#[test]
fn opening_requires_active_creator_and_rejects_cutoff_or_reopening() {
    let mut f = Fixture::new();
    f.send(f.creation(f.terms(3))).expect("draft");
    f.admin_status(AdminStatus::Disabled);
    f.reject(f.manage(true), Some("AdminDisabled"));
    f.admin_status(AdminStatus::Active);
    let mut foreign = f.manage(true);
    foreign.accounts[0].pubkey = f.attacker.pubkey();
    f.reject(foreign, Some("UnauthorizedPredictionAuthority"));
    let mut clock = f.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 200;
    f.svm.set_sysvar(&clock);
    f.reject(f.manage(true), Some("PredictionOpeningClosed"));
    clock.unix_timestamp = 199;
    f.svm.set_sysvar(&clock);
    f.send(f.manage(true)).expect("before cutoff");
    f.reject(f.manage(true), Some("PredictionNotDraft"));
}

#[test]
fn splits_stop_at_cutoff_but_merges_survive_closure_and_admin_revocation() {
    let mut f = Fixture::new();
    f.setup(3, 9_000_000);
    f.send(f.complete(3, true)).expect("split");
    f.send(f.manage(false)).expect("freeze");
    f.reject(f.complete(3, true), Some("PredictionSplitUnavailable"));
    f.admin_status(AdminStatus::Disabled);
    let mut clock = f.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 201;
    f.svm.set_sysvar(&clock);
    f.send(f.complete(3, false))
        .expect("owner merge without any active admin");
    assert_eq!(f.balance().free, 9_000_000);
    let mut g = Fixture::new();
    g.setup(3, 9_000_000);
    clock = g.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 200;
    g.svm.set_sysvar(&clock);
    g.reject(g.complete(3, true), Some("PredictionSplitUnavailable"));
}

#[test]
fn split_needs_free_cash_and_whole_lots_with_atomic_failure() {
    let mut f = Fixture::new();
    f.setup(3, 2_000_000);
    f.reject(f.complete(3, true), Some("InsufficientFreeBalance"));
    for q in [0, 1, 2, 4] {
        f.reject(f.complete(q, true), Some("InvalidMultiOutcomeLot"));
    }
    let mut b = f.balance();
    b.free = 0;
    b.locked = 2_000_000;
    let key = f.balance_key();
    store(&mut f.svm, key, &b);
    f.reject(f.complete(3, true), Some("InsufficientFreeBalance"));
    assert_eq!(f.balance().locked, 2_000_000);
}

#[test]
fn merge_needs_every_free_outcome_and_cannot_burn_locked_positions() {
    let mut f = Fixture::new();
    f.setup(3, 6_000_000);
    f.send(f.complete(3, true)).expect("split");
    let mut p = f.position();
    p.free[1] = 0;
    p.locked[1] = 3;
    let key = f.position_key();
    store(&mut f.svm, key, &p);
    f.reject(
        f.complete(3, false),
        Some("InsufficientPredictionPositions"),
    );
    assert_eq!(f.position().locked[1], 3);
    p.free[1] = 3;
    p.locked[1] = 0;
    store(&mut f.svm, key, &p);
    f.send(f.complete(3, false))
        .expect("released contracts merge");
}

#[test]
fn canonical_account_and_owner_constraints_reject_foreign_inputs() {
    let mut f = Fixture::new();
    f.setup(3, 9_000_000);
    for index in [0, 2, 3, 4, 5, 6, 7, 8] {
        let mut ix = f.complete(3, true);
        ix.accounts[index].pubkey = if index == 0 {
            f.attacker.pubkey()
        } else {
            Pubkey::new_unique()
        };
        f.reject(ix, None);
    }
    let mut missing = f.complete(3, true);
    missing.accounts[0].is_signer = false;
    f.reject(missing, Some("AccountNotSigner"));
}

#[test]
fn frozen_reserve_cpi_rolls_back_all_recorded_claims() {
    let mut f = Fixture::new();
    f.setup(3, 9_000_000);
    let freeze = spl_token::instruction::freeze_account(
        &spl_token::ID,
        &f.reserve(),
        &f.mint,
        &f.admin.pubkey(),
        &[],
    )
    .expect("freeze ix");
    f.send(freeze).expect("freeze SPL account");
    f.reject(f.complete(3, true), None);
    assert_eq!(f.balance().free, 9_000_000);
    assert_eq!(f.market().supplies, [0; 8]);
    assert_eq!(f.tokens(f.global()), 9_000_000);
}

#[test]
fn reserve_donations_do_not_mint_claims_or_block_exits() {
    let mut f = Fixture::new();
    f.setup(3, 9_000_000);
    f.send(f.complete(3, true)).expect("split");
    let donation = spl_token::instruction::transfer_checked(
        &spl_token::ID,
        &f.wallet,
        &f.mint,
        &f.reserve(),
        &f.owner.pubkey(),
        &[],
        1,
        6,
    )
    .expect("donation");
    f.send(donation).expect("unsolicited transfer");
    f.send(f.complete(3, false))
        .expect("merge despite donation");
    assert_eq!(f.market().backing_reserve, 0);
    assert_eq!(f.tokens(f.reserve()), 1);
    assert_eq!(f.balance().free, 9_000_000);
    assert_eq!(
        f.tokens(f.wallet) + f.tokens(f.global()) + f.tokens(f.reserve()),
        100_000_000
    );
}

#[test]
fn inconsistent_backing_or_inactive_positions_fail_closed() {
    let mut f = Fixture::new();
    f.setup(3, 9_000_000);
    f.send(f.complete(3, true)).expect("split");
    let mut market = f.market();
    market.backing_reserve += 1;
    let key = f.market_key();
    store(&mut f.svm, key, &market);
    f.reject(f.complete(3, false), Some("MultiOutcomeReserveMismatch"));
    market.backing_reserve -= 1;
    store(&mut f.svm, key, &market);
    let mut p = f.position();
    p.free[7] = 3;
    let key = f.position_key();
    store(&mut f.svm, key, &p);
    f.reject(f.complete(3, false), Some("MultiOutcomeInactiveSlot"));
}

#[test]
fn physical_underbacking_and_wrong_position_owner_are_rejected() {
    let mut f = Fixture::new();
    f.setup(3, 6_000_000);
    f.send(f.complete(3, true)).expect("split");
    let key = f.reserve();
    let original = f.svm.get_account(&key).expect("reserve");
    let mut broken = original.clone();
    let mut token = TokenAccount::unpack(&broken.data).expect("token");
    token.amount -= 1;
    TokenAccount::pack(token, &mut broken.data).expect("pack");
    f.svm.set_account(key, broken).expect("fault injection");
    f.reject(f.complete(3, false), Some("MultiOutcomeReserveMismatch"));
    f.svm.set_account(key, original).expect("restore");
    let key = f.position_key();
    let mut position = f.position();
    position.owner = f.attacker.pubkey();
    store(&mut f.svm, key, &position);
    f.reject(f.complete(3, false), Some("InvalidMultiOutcomePosition"));
}

#[test]
fn all_supported_counts_create_and_fund_without_touching_unused_slots() {
    for count in 2..=8 {
        let mut f = Fixture::new();
        let ix = f.creation(f.terms(count));
        let size = wincode::serialize(&f.transaction(ix))
            .expect("wire transaction")
            .len();
        assert!(size <= 1232, "{count} short labels require {size} bytes");
        f.setup(count, 10_000_000);
        f.send(f.complete(u64::from(count), true)).expect("split");
        f.send(f.complete(u64::from(count), false)).expect("merge");
        assert_eq!(f.position().free, [0; 8]);
        assert_eq!(f.market().supplies, [0; 8]);
        assert_eq!(f.balance().free, 10_000_000);
    }
}

#[test]
fn non_admin_creation_and_non_mint_collateral_are_rejected() {
    let mut f = Fixture::new();
    let mut ix = f.creation(f.terms(3));
    ix.accounts[0].pubkey = f.owner.pubkey();
    ix.accounts[1].pubkey = pda(ADMIN_SEED, &[f.owner.pubkey().as_ref()]);
    f.reject(ix, Some("AccountNotInitialized"));
    let mut ix = f.creation(f.terms(3));
    ix.accounts[3].pubkey = f.wallet;
    f.reject(ix, None);
    assert!(f.svm.get_account(&f.market_key()).is_none());
}

#[test]
fn maximum_string_allocations_are_not_a_promise_of_single_packet_creation() {
    let f = Fixture::new();
    let mut terms = f.terms(8);
    terms.outcome_labels = (0..8).map(|i| format!("{i}{}", "x".repeat(63))).collect();
    terms.rules_uri = format!("https://{}", "x".repeat(192));
    terms.earliest_resolution_ts = Some(220);
    terms.fallback = Some(PredictionFallback {
        resolver: f.attacker.pubkey(),
        available_ts: 300,
        deadline_ts: Some(400),
    });
    let tx = f.transaction(f.creation(terms));
    // Pure term validation and rent allocation bounds are distinct from Solana's
    // wire limit. A later client must check final signed bytes or stage large terms.
    assert!(wincode::serialize(&tx).expect("wire transaction").len() > 1232);
}

#[test]
fn two_multi_outcome_markets_reuse_one_funded_asset_balance() {
    let mut f = Fixture::new();
    f.setup(3, 12_000_000);
    f.send(f.complete(3, true)).expect("first market split");
    let first_market = f.market_key();
    let first_reserve = f.reserve();
    let balance = f.balance_key();
    f.id = [32; 32];
    f.send(f.creation(f.terms(4))).expect("second draft");
    f.send(f.position_init()).expect("second position");
    f.send(f.manage(true)).expect("second open");
    assert_eq!(f.balance_key(), balance);
    f.send(f.complete(4, true)).expect("second market split");
    assert_eq!(f.balance().free, 5_000_000);
    assert_eq!(f.tokens(first_reserve), 3_000_000);
    assert_eq!(f.tokens(f.reserve()), 4_000_000);
    assert_eq!(
        f.read::<MultiOutcomeMarket>(first_market).supplies,
        [3, 3, 3, 0, 0, 0, 0, 0]
    );
    f.send(f.complete(4, false)).expect("second merge");
    f.id = [31; 32];
    f.send(f.complete(3, false)).expect("first merge");
    assert_eq!(f.balance().free, 12_000_000);
    assert_eq!(f.tokens(f.global()), 12_000_000);
}

#[test]
fn finalized_markets_cannot_share_complete_set_merge_accounting() {
    let mut f = Fixture::new();
    f.setup(3, 6_000_000);
    f.send(f.complete(3, true)).expect("split");
    let mut market = f.market();
    market.status = PredictionStatus::Resolved;
    market.final_outcome = Some(MultiOutcomeResolution::Winner(
        OutcomeId::new(0, 3).expect("winner"),
    ));
    let key = f.market_key();
    store(&mut f.svm, key, &market);
    f.reject(f.complete(3, false), Some("PredictionMergeUnavailable"));
    f.reject(f.complete(3, true), Some("PredictionSplitUnavailable"));
}
