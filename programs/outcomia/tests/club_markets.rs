//! LiteSVM coverage for binary club markets: creation, lifecycle, custody,
//! resolution and isolation from public instructions.

#![allow(clippy::result_large_err)]

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenState, AccountState, Mint};
use litesvm::LiteSVM;
use outcomia::{constants::*, prediction_config::PredictionMarketConfig, state::*};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const PROGRAM_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/outcomia.so"
));
const CLUB_ID: [u8; 32] = [7; 32];
const MARKET_ID: [u8; 32] = [3; 32];
const PAYOUT: u64 = 1_000_000;

fn pda(seed: &[u8], parts: &[&[u8]]) -> Pubkey {
    let mut seeds = vec![seed];
    seeds.extend_from_slice(parts);
    Pubkey::find_program_address(&seeds, &outcomia::ID).0
}
fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(outcomia::ID, &data.data(), accounts.to_account_metas(None))
}

struct Fixture {
    svm: LiteSVM,
    owner: Keypair,
    club: Pubkey,
    mint: Pubkey,
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM_BYTES).unwrap();
        let owner = Keypair::new();
        svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
        let mint = Pubkey::new_unique();
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: Some(owner.pubkey()).into(),
                supply: 1_000_000_000_000,
                decimals: 6,
                is_initialized: true,
                freeze_authority: None.into(),
            },
            &mut data,
        )
        .unwrap();
        let lamports = svm.minimum_balance_for_rent_exemption(data.len());
        svm.set_account(
            mint,
            Account {
                lamports,
                data,
                owner: anchor_spl::token::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let mut f = Fixture {
            svm,
            owner,
            club: pda(CLUB_SEED, &[&CLUB_ID]),
            mint,
        };
        f.set_clock(100);
        let owner = f.owner.insecure_clone();
        f.ok(
            &owner,
            ix(
                outcomia::accounts::CreateClub {
                    owner: owner.pubkey(),
                    club: f.club,
                    owner_member: f.member_pda(&owner.pubkey()),
                    system_program: system_program::ID,
                },
                outcomia::instruction::CreateClub {
                    club_id: CLUB_ID,
                    name: "Club".into(),
                },
            ),
        );
        f
    }
    fn wallet(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
        k
    }
    fn member_pda(&self, wallet: &Pubkey) -> Pubkey {
        pda(CLUB_MEMBER_SEED, &[self.club.as_ref(), wallet.as_ref()])
    }
    /// Invites and accepts a fresh wallet; promotes it when `admin`.
    fn join(&mut self, admin: bool) -> Keypair {
        let owner = self.owner.insecure_clone();
        let wallet = self.wallet();
        let invite = pda(
            CLUB_INVITE_SEED,
            &[self.club.as_ref(), wallet.pubkey().as_ref()],
        );
        self.ok(
            &owner,
            ix(
                outcomia::accounts::InviteClubMember {
                    inviter: owner.pubkey(),
                    club: self.club,
                    inviter_member: self.member_pda(&owner.pubkey()),
                    existing_member: self.member_pda(&wallet.pubkey()),
                    invite,
                    system_program: system_program::ID,
                },
                outcomia::instruction::InviteClubMember {
                    wallet: wallet.pubkey(),
                },
            ),
        );
        self.ok(
            &wallet,
            ix(
                outcomia::accounts::AcceptClubInvite {
                    wallet: wallet.pubkey(),
                    club: self.club,
                    invite,
                    inviter: owner.pubkey(),
                    member: self.member_pda(&wallet.pubkey()),
                    system_program: system_program::ID,
                },
                outcomia::instruction::AcceptClubInvite {},
            ),
        );
        if admin {
            self.ok(
                &owner,
                ix(
                    outcomia::accounts::SetClubMemberRole {
                        owner: owner.pubkey(),
                        club: self.club,
                        member: self.member_pda(&wallet.pubkey()),
                    },
                    outcomia::instruction::SetClubMemberRole {
                        role: ClubRole::Admin,
                    },
                ),
            );
        }
        wallet
    }
    fn remove(&mut self, wallet: &Pubkey) {
        let owner = self.owner.insecure_clone();
        self.ok(
            &owner,
            ix(
                outcomia::accounts::RemoveClubMember {
                    admin: owner.pubkey(),
                    club: self.club,
                    admin_member: self.member_pda(&owner.pubkey()),
                    member: self.member_pda(wallet),
                    wallet: *wallet,
                },
                outcomia::instruction::RemoveClubMember {},
            ),
        );
    }
    fn set_clock(&mut self, now: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp = now;
        self.svm.set_sysvar(&c);
    }
    fn send(&mut self, signer: &Keypair, ix: Instruction) -> Result<(), Vec<String>> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            &[ix],
            Some(&signer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| e.meta.logs)
    }
    fn ok(&mut self, signer: &Keypair, ix: Instruction) {
        if let Err(logs) = self.send(signer, ix) {
            panic!("transaction should succeed: {logs:#?}");
        }
    }
    fn fails(&mut self, signer: &Keypair, ix: Instruction, error: &str) {
        let logs = self.send(signer, ix).expect_err("transaction should fail");
        let needle = format!("Error Code: {error}.");
        assert!(
            logs.iter().any(|l| l.contains(&needle)),
            "expected {error}: {logs:#?}"
        );
    }
    fn load<T: AccountDeserialize>(&self, address: &Pubkey) -> Option<T> {
        let account = self.svm.get_account(address)?;
        (!account.data.is_empty())
            .then(|| T::try_deserialize(&mut account.data.as_slice()).unwrap())
    }
    fn market(&self) -> PredictionMarket {
        self.load(&market_pda(&MARKET_ID)).unwrap()
    }

    fn token_amount(&self, address: &Pubkey) -> u64 {
        TokenState::unpack(&self.svm.get_account(address).unwrap().data)
            .unwrap()
            .amount
    }
    fn balance_pda(&self, owner: &Pubkey) -> Pubkey {
        pda(ASSET_BALANCE_SEED, &[owner.as_ref(), self.mint.as_ref()])
    }
    fn free_cash(&self, owner: &Pubkey) -> u64 {
        self.load::<AssetBalance>(&self.balance_pda(owner))
            .unwrap()
            .free
    }
    fn position(&self, owner: &Pubkey) -> PredictionPosition {
        let market = market_pda(&MARKET_ID);
        self.load(&pda(
            PREDICTION_POSITION_SEED,
            &[market.as_ref(), owner.as_ref()],
        ))
        .unwrap()
    }
    /// Deposits `amount` collateral atoms into the wallet's shared balance and
    /// creates its club position.
    fn fund(&mut self, wallet: &Keypair, amount: u64) {
        let token = Pubkey::new_unique();
        let state = TokenState {
            mint: self.mint,
            owner: wallet.pubkey(),
            amount,
            delegate: None.into(),
            state: AccountState::Initialized,
            is_native: None.into(),
            delegated_amount: 0,
            close_authority: None.into(),
        };
        let mut data = vec![0; TokenState::LEN];
        TokenState::pack(state, &mut data).unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                token,
                Account {
                    lamports,
                    data,
                    owner: anchor_spl::token::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        let (owner, mint) = (wallet.pubkey(), self.mint);
        let balance = self.balance_pda(&owner);
        let authority = pda(ASSET_AUTHORITY_SEED, &[mint.as_ref()]);
        let vault = pda(ASSET_VAULT_SEED, &[mint.as_ref()]);
        self.ok(
            wallet,
            ix(
                outcomia::accounts::InitializeAssetBalance {
                    owner,
                    mint,
                    asset_balance: balance,
                    vault_authority: authority,
                    asset_vault: vault,
                    token_program: anchor_spl::token::ID,
                    system_program: system_program::ID,
                },
                outcomia::instruction::InitializeAssetBalance {},
            ),
        );
        self.ok(
            wallet,
            ix(
                outcomia::accounts::TransferAsset {
                    owner,
                    mint,
                    asset_balance: balance,
                    wallet_token: token,
                    vault_authority: authority,
                    asset_vault: vault,
                    token_program: anchor_spl::token::ID,
                },
                outcomia::instruction::DepositAsset { amount },
            ),
        );
        self.ok(wallet, self.init_position(&owner));
    }
    fn custody_accounts(
        &self,
        owner: &Pubkey,
        with_member: bool,
    ) -> outcomia::accounts::ClubPredictionCustody {
        let market = market_pda(&MARKET_ID);
        outcomia::accounts::ClubPredictionCustody {
            owner: *owner,
            market,
            club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
            member: with_member.then(|| self.member_pda(owner)),
            position: pda(PREDICTION_POSITION_SEED, &[market.as_ref(), owner.as_ref()]),
            mint: self.mint,
            asset_balance: self.balance_pda(owner),
            asset_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
            asset_vault: pda(ASSET_VAULT_SEED, &[self.mint.as_ref()]),
            market_authority: pda(VAULT_AUTHORITY_SEED, &[market.as_ref()]),
            market_vault: pda(VAULT_SEED, &[market.as_ref(), self.mint.as_ref()]),
            token_program: anchor_spl::token::ID,
        }
    }
    fn complete_set(
        &self,
        owner: &Pubkey,
        with_member: bool,
        quantity: u64,
        split: bool,
    ) -> Instruction {
        ix(
            self.custody_accounts(owner, with_member),
            outcomia::instruction::ClubCompleteSet { quantity, split },
        )
    }
    fn market_vault(&self) -> Pubkey {
        pda(
            VAULT_SEED,
            &[market_pda(&MARKET_ID).as_ref(), self.mint.as_ref()],
        )
    }

    fn create_market(
        &self,
        creator: &Pubkey,
        market_id: [u8; 32],
        config: PredictionMarketConfig,
        access: ClubMarketAccess,
    ) -> Instruction {
        let market = market_pda(&market_id);
        ix(
            outcomia::accounts::CreateClubPredictionMarket {
                creator: *creator,
                club: self.club,
                creator_member: self.member_pda(creator),
                market,
                club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
                collateral_mint: self.mint,
                vault_authority: pda(VAULT_AUTHORITY_SEED, &[market.as_ref()]),
                collateral_vault: pda(VAULT_SEED, &[market.as_ref(), self.mint.as_ref()]),
                market_metadata: pda(MARKET_METADATA_SEED, &[market.as_ref()]),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            },
            outcomia::instruction::CreateClubPredictionMarket {
                market_id,
                config,
                display_name: "Will it rain?".into(),
                collateral_symbol: "USDC".into(),
                access,
            },
        )
    }
    fn manage(&self, actor: &Pubkey, open: bool) -> Instruction {
        let market = market_pda(&MARKET_ID);
        let accounts = outcomia::accounts::ManageClubPredictionMarket {
            actor: *actor,
            club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
            market,
            actor_member: self.member_pda(actor),
        };
        if open {
            ix(accounts, outcomia::instruction::OpenClubPredictionMarket {})
        } else {
            ix(accounts, outcomia::instruction::CloseClubTrading {})
        }
    }
    /// Creates and opens the default market as the owner.
    fn open_market(&mut self, access: ClubMarketAccess) {
        let owner = self.owner.insecure_clone();
        self.ok(
            &owner,
            self.create_market(&owner.pubkey(), MARKET_ID, config(&owner.pubkey()), access),
        );
        self.ok(&owner, self.manage(&owner.pubkey(), true));
    }
    fn init_position(&self, owner: &Pubkey) -> Instruction {
        let market = market_pda(&MARKET_ID);
        ix(
            outcomia::accounts::InitializeClubPosition {
                owner: *owner,
                market,
                position: pda(PREDICTION_POSITION_SEED, &[market.as_ref(), owner.as_ref()]),
                system_program: system_program::ID,
            },
            outcomia::instruction::InitializeClubPosition {},
        )
    }
}

fn market_pda(market_id: &[u8; 32]) -> Pubkey {
    pda(CLUB_PREDICTION_MARKET_SEED, &[market_id])
}
fn config(creator: &Pubkey) -> PredictionMarketConfig {
    PredictionMarketConfig {
        resolver: *creator,
        fallback: None,
        close_ts: 200,
        earliest_resolution_ts: None,
        resolution_delay_seconds: 10,
        payout_per_contract: PAYOUT,
        price_tick: 10_000,
        rules_uri: format!("ar://{}", "a".repeat(43)),
        question_hash: [1; 32],
        rules_hash: [2; 32],
    }
}

#[test]
fn club_admin_creates_a_draft_club_market_bound_to_the_club() {
    let mut f = Fixture::new();
    let admin = f.join(true);
    f.ok(
        &admin,
        f.create_market(
            &admin.pubkey(),
            MARKET_ID,
            config(&admin.pubkey()),
            ClubMarketAccess::MembersOnly,
        ),
    );
    let market = f.market();
    assert_eq!(market.status, PredictionStatus::Draft);
    assert_eq!(
        (market.authority, market.resolver, market.fallback.clone()),
        (admin.pubkey(), admin.pubkey(), None)
    );
    assert_eq!((market.yes_supply, market.backing_reserve), (0, 0));
    let binding: ClubMarket = f
        .load(&pda(CLUB_MARKET_SEED, &[market_pda(&MARKET_ID).as_ref()]))
        .unwrap();
    assert_eq!(binding.club, f.club);
    assert_eq!(binding.market, market_pda(&MARKET_ID));
    assert_eq!(binding.access, ClubMarketAccess::MembersOnly);
    assert_eq!(
        (binding.creator, binding.accrued_club_fees),
        (admin.pubkey(), 0)
    );
    let metadata: MarketMetadata = f
        .load(&pda(
            MARKET_METADATA_SEED,
            &[market_pda(&MARKET_ID).as_ref()],
        ))
        .unwrap();
    assert_eq!(
        (metadata.display_name.as_str(), metadata.kind),
        ("Will it rain?", MarketKind::Prediction)
    );
}

#[test]
fn market_creation_follows_the_club_policy() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let member = f.join(false);
    let outsider = f.wallet();
    f.fails(
        &member,
        f.create_market(
            &member.pubkey(),
            MARKET_ID,
            config(&member.pubkey()),
            ClubMarketAccess::Public,
        ),
        "UnauthorizedClubAdmin",
    );
    f.fails(
        &outsider,
        f.create_market(
            &outsider.pubkey(),
            MARKET_ID,
            config(&outsider.pubkey()),
            ClubMarketAccess::Public,
        ),
        "AccountNotInitialized",
    );
    f.ok(
        &owner,
        ix(
            outcomia::accounts::ManageClub {
                admin: owner.pubkey(),
                club: f.club,
                admin_member: f.member_pda(&owner.pubkey()),
            },
            outcomia::instruction::SetClubMarketPolicy {
                policy: ClubMarketPolicy::AnyMember,
            },
        ),
    );
    f.ok(
        &member,
        f.create_market(
            &member.pubkey(),
            MARKET_ID,
            config(&member.pubkey()),
            ClubMarketAccess::Public,
        ),
    );
}

#[test]
fn club_markets_reject_fallbacks_foreign_resolvers_and_bad_terms() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let other = Pubkey::new_unique();
    let mut c = config(&other);
    f.fails(
        &owner,
        f.create_market(
            &owner.pubkey(),
            MARKET_ID,
            c.clone(),
            ClubMarketAccess::Public,
        ),
        "InvalidClubMarket",
    );
    c = config(&owner.pubkey());
    c.fallback = Some(PredictionFallback {
        resolver: other,
        available_ts: 300,
        deadline_ts: None,
    });
    f.fails(
        &owner,
        f.create_market(&owner.pubkey(), MARKET_ID, c, ClubMarketAccess::Public),
        "InvalidClubMarket",
    );
    c = config(&owner.pubkey());
    c.payout_per_contract = 2 * PAYOUT;
    f.fails(
        &owner,
        f.create_market(&owner.pubkey(), MARKET_ID, c, ClubMarketAccess::Public),
        "InvalidPredictionPayout",
    );
    c = config(&owner.pubkey());
    c.close_ts = 100;
    assert!(f
        .send(
            &owner,
            f.create_market(&owner.pubkey(), MARKET_ID, c, ClubMarketAccess::Public)
        )
        .is_err());
}

#[test]
fn admins_or_the_creating_member_open_and_close_club_markets() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let creator = f.join(false);
    let bystander = f.join(false);
    let admin = f.join(true);
    f.ok(
        &owner,
        ix(
            outcomia::accounts::ManageClub {
                admin: owner.pubkey(),
                club: f.club,
                admin_member: f.member_pda(&owner.pubkey()),
            },
            outcomia::instruction::SetClubMarketPolicy {
                policy: ClubMarketPolicy::AnyMember,
            },
        ),
    );
    f.ok(
        &creator,
        f.create_market(
            &creator.pubkey(),
            MARKET_ID,
            config(&creator.pubkey()),
            ClubMarketAccess::MembersOnly,
        ),
    );
    f.fails(
        &bystander,
        f.manage(&bystander.pubkey(), true),
        "UnauthorizedClubAdmin",
    );
    f.ok(&creator, f.manage(&creator.pubkey(), true));
    assert_eq!(f.market().status, PredictionStatus::Open);
    f.fails(
        &creator,
        f.manage(&creator.pubkey(), true),
        "PredictionNotDraft",
    );
    // A creator who leaves loses the right; admins keep it.
    f.remove(&creator.pubkey());
    f.fails(
        &creator,
        f.manage(&creator.pubkey(), false),
        "AccountNotInitialized",
    );
    f.ok(&admin, f.manage(&admin.pubkey(), false));
    assert_eq!(f.market().status, PredictionStatus::Frozen);
    f.fails(
        &admin,
        f.manage(&admin.pubkey(), false),
        "PredictionResolutionUnavailable",
    );
}

#[test]
fn drafts_cannot_open_after_their_close_time() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    f.ok(
        &owner,
        f.create_market(
            &owner.pubkey(),
            MARKET_ID,
            config(&owner.pubkey()),
            ClubMarketAccess::Public,
        ),
    );
    f.set_clock(200);
    f.fails(
        &owner,
        f.manage(&owner.pubkey(), true),
        "PredictionOpeningClosed",
    );
}

#[test]
fn anyone_holds_a_club_position_but_public_instructions_cannot_reach_club_markets() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::MembersOnly);
    let outsider = f.wallet();
    f.ok(&outsider, f.init_position(&outsider.pubkey()));
    let market = market_pda(&MARKET_ID);
    let position: PredictionPosition = f
        .load(&pda(
            PREDICTION_POSITION_SEED,
            &[market.as_ref(), outsider.pubkey().as_ref()],
        ))
        .unwrap();
    assert_eq!(
        (position.market, position.owner, position.yes_free),
        (market, outsider.pubkey(), 0)
    );

    // The public position initializer derives the public market seed.
    let other = f.wallet();
    let public_init = ix(
        outcomia::accounts::InitializePredictionPosition {
            owner: other.pubkey(),
            market,
            position: pda(
                PREDICTION_POSITION_SEED,
                &[market.as_ref(), other.pubkey().as_ref()],
            ),
            system_program: system_program::ID,
        },
        outcomia::instruction::InitializePredictionPosition {},
    );
    f.fails(&other, public_init, "ConstraintSeeds");
    // So does public resolution, even for the market's own creator.
    let owner = f.owner.insecure_clone();
    let public_freeze = ix(
        outcomia::accounts::AdvancePrediction { market },
        outcomia::instruction::AdvancePrediction { action: 0 },
    );
    f.set_clock(200);
    f.fails(&owner, public_freeze, "ConstraintSeeds");
}

#[test]
fn members_split_and_merge_with_exact_backing() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::MembersOnly);
    let member = f.join(false);
    f.fund(&member, 10 * PAYOUT);
    f.ok(&member, f.complete_set(&member.pubkey(), true, 4, true));
    let p = f.position(&member.pubkey());
    assert_eq!((p.yes_free, p.no_free), (4, 4));
    let m = f.market();
    assert_eq!(
        (m.yes_supply, m.no_supply, m.backing_reserve),
        (4, 4, 4 * PAYOUT)
    );
    assert_eq!(f.token_amount(&f.market_vault()), 4 * PAYOUT);
    assert_eq!(f.free_cash(&member.pubkey()), 6 * PAYOUT);

    f.ok(&member, f.complete_set(&member.pubkey(), false, 1, false));
    assert_eq!(f.market().backing_reserve, 3 * PAYOUT);
    assert_eq!(f.token_amount(&f.market_vault()), 3 * PAYOUT);
    assert_eq!(f.free_cash(&member.pubkey()), 7 * PAYOUT);
}

#[test]
fn members_only_splits_need_current_membership_but_merges_never_do() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::MembersOnly);
    let member = f.join(false);
    let outsider = f.wallet();
    f.fund(&member, 10 * PAYOUT);
    f.fund(&outsider, 10 * PAYOUT);
    f.fails(
        &outsider,
        f.complete_set(&outsider.pubkey(), false, 1, true),
        "ClubMembershipRequired",
    );
    // Another wallet's membership is not a pass.
    let mut borrowed = f.complete_set(&outsider.pubkey(), false, 1, true);
    borrowed.accounts[3] = anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        f.member_pda(&member.pubkey()),
        false,
    );
    f.fails(&outsider, borrowed, "ClubMembershipRequired");
    // Membership of a different club is not a pass either.
    let rival = f.wallet();
    let rival_club = pda(CLUB_SEED, &[&[9; 32]]);
    f.ok(
        &rival,
        ix(
            outcomia::accounts::CreateClub {
                owner: rival.pubkey(),
                club: rival_club,
                owner_member: pda(
                    CLUB_MEMBER_SEED,
                    &[rival_club.as_ref(), rival.pubkey().as_ref()],
                ),
                system_program: system_program::ID,
            },
            outcomia::instruction::CreateClub {
                club_id: [9; 32],
                name: "Rival".into(),
            },
        ),
    );
    f.fund(&rival, PAYOUT);
    let mut foreign = f.complete_set(&rival.pubkey(), false, 1, true);
    foreign.accounts[3] = anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        pda(
            CLUB_MEMBER_SEED,
            &[rival_club.as_ref(), rival.pubkey().as_ref()],
        ),
        false,
    );
    f.fails(&rival, foreign, "ClubMembershipRequired");

    f.ok(&member, f.complete_set(&member.pubkey(), true, 3, true));
    f.remove(&member.pubkey());
    f.fails(
        &member,
        f.complete_set(&member.pubkey(), false, 1, true),
        "ClubMembershipRequired",
    );
    // The former member still exits, with no membership account at all.
    f.ok(&member, f.complete_set(&member.pubkey(), false, 3, false));
    assert_eq!(f.free_cash(&member.pubkey()), 10 * PAYOUT);
    assert_eq!(f.market().backing_reserve, 0);
}

#[test]
fn public_club_markets_let_anyone_split() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::Public);
    let outsider = f.wallet();
    f.fund(&outsider, 2 * PAYOUT);
    f.ok(
        &outsider,
        f.complete_set(&outsider.pubkey(), false, 2, true),
    );
    assert_eq!(f.position(&outsider.pubkey()).yes_free, 2);
}

#[test]
fn club_splits_follow_the_market_lifecycle() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    f.ok(
        &owner,
        f.create_market(
            &owner.pubkey(),
            MARKET_ID,
            config(&owner.pubkey()),
            ClubMarketAccess::Public,
        ),
    );
    f.fund(&owner, 5 * PAYOUT);
    f.fails(
        &owner,
        f.complete_set(&owner.pubkey(), true, 1, true),
        "PredictionSplitUnavailable",
    );
    f.ok(&owner, f.manage(&owner.pubkey(), true));
    f.ok(&owner, f.complete_set(&owner.pubkey(), true, 2, true));
    f.ok(&owner, f.manage(&owner.pubkey(), false));
    f.fails(
        &owner,
        f.complete_set(&owner.pubkey(), true, 1, true),
        "PredictionSplitUnavailable",
    );
    f.ok(&owner, f.complete_set(&owner.pubkey(), true, 2, false));
}

#[test]
fn public_custody_cannot_touch_club_market_reserves() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::Public);
    let owner = f.owner.insecure_clone();
    f.fund(&owner, 5 * PAYOUT);
    let c = f.custody_accounts(&owner.pubkey(), false);
    let public = ix(
        outcomia::accounts::SharedPredictionCustody {
            owner: c.owner,
            market: c.market,
            position: c.position,
            mint: c.mint,
            asset_balance: c.asset_balance,
            asset_authority: c.asset_authority,
            asset_vault: c.asset_vault,
            market_authority: c.market_authority,
            market_vault: c.market_vault,
            token_program: c.token_program,
        },
        outcomia::instruction::SharedCompleteSet {
            quantity: 1,
            split: true,
        },
    );
    f.fails(&owner, public, "ConstraintSeeds");
}
