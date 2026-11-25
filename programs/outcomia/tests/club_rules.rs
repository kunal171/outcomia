//! LiteSVM coverage for platform club rules: types, member caps, owned-club
//! and admin limits, listing eligibility and the legacy-club migration.

#![allow(clippy::result_large_err)]

use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::Instruction, solana_program::system_program,
    AccountDeserialize, AccountSerialize, AnchorSerialize, Discriminator, InstructionData,
    ToAccountMetas,
};
use litesvm::LiteSVM;
use outcomia::{constants::*, state::*};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

const PROGRAM_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/outcomia.so"
));

fn pda(parts: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(parts, &outcomia::ID).0
}
fn club_pda(id: &[u8; 32]) -> Pubkey {
    pda(&[CLUB_SEED, id])
}
fn member_pda(club: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[CLUB_MEMBER_SEED, club.as_ref(), wallet.as_ref()])
}
fn rules_pda() -> Pubkey {
    pda(&[CLUB_RULES_CONFIG_SEED])
}
fn record_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[CLUB_OWNER_SEED, wallet.as_ref()])
}
fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(outcomia::ID, &data.data(), accounts.to_account_metas(None))
}

struct Fixture {
    svm: LiteSVM,
    super_admin: Keypair,
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM_BYTES).unwrap();
        let super_admin = Keypair::new();
        svm.airdrop(&super_admin.pubkey(), 10_000_000_000).unwrap();
        let mut f = Fixture { svm, super_admin };
        let (address, bump) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &outcomia::ID);
        let mut data = Vec::new();
        ProtocolConfig {
            super_admin: f.super_admin.pubkey(),
            taker_fee_bps: 0,
            bump,
        }
        .try_serialize(&mut data)
        .unwrap();
        f.store(address, data);
        f
    }
    fn store(&mut self, address: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                solana_account::Account {
                    lamports,
                    data,
                    owner: outcomia::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
    fn wallet(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 5_000_000_000).unwrap();
        k
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
        if account.data.is_empty() {
            return None;
        }
        Some(T::try_deserialize(&mut account.data.as_slice()).unwrap())
    }
    fn rules(&mut self, public: u32, private: u32, owned: u16, admins: u16) {
        let sa = self.super_admin.insecure_clone();
        self.ok(&sa, set_rules(&sa.pubkey(), public, private, owned, admins));
    }
    fn create(&mut self, owner: &Keypair, id: u8, kind: ClubKind) -> Pubkey {
        self.ok(owner, create(&owner.pubkey(), [id; 32], kind));
        club_pda(&[id; 32])
    }
    fn join(&mut self, club: &Pubkey, owner: &Keypair) -> Result<Keypair, Vec<String>> {
        let wallet = self.wallet();
        self.ok(owner, invite(club, &owner.pubkey(), &wallet.pubkey()));
        self.send(&wallet, accept(club, &wallet.pubkey(), &owner.pubkey()))?;
        Ok(wallet)
    }
    fn owned(&self, wallet: &Pubkey) -> u16 {
        self.load::<ClubOwnerRecord>(&record_pda(wallet))
            .map_or(0, |r| r.owned)
    }
}

fn set_rules(sa: &Pubkey, public: u32, private: u32, owned: u16, admins: u16) -> Instruction {
    ix(
        outcomia::accounts::SetClubRules {
            super_admin: *sa,
            protocol_config: pda(&[PROTOCOL_CONFIG_SEED]),
            club_rules: rules_pda(),
            system_program: system_program::ID,
        },
        outcomia::instruction::SetClubRules {
            public_member_cap: public,
            private_member_cap: private,
            max_owned_clubs: owned,
            max_club_admins: admins,
        },
    )
}
fn create(owner: &Pubkey, club_id: [u8; 32], kind: ClubKind) -> Instruction {
    let club = club_pda(&club_id);
    ix(
        outcomia::accounts::CreateClub {
            owner: *owner,
            club_rules: rules_pda(),
            owner_record: record_pda(owner),
            club,
            owner_member: member_pda(&club, owner),
            system_program: system_program::ID,
        },
        outcomia::instruction::CreateClub {
            club_id,
            name: "Club".into(),
            kind,
        },
    )
}
fn invite(club: &Pubkey, admin: &Pubkey, wallet: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::InviteClubMember {
            inviter: *admin,
            club: *club,
            inviter_member: member_pda(club, admin),
            existing_member: member_pda(club, wallet),
            invite: pda(&[CLUB_INVITE_SEED, club.as_ref(), wallet.as_ref()]),
            system_program: system_program::ID,
        },
        outcomia::instruction::InviteClubMember { wallet: *wallet },
    )
}
fn accept(club: &Pubkey, wallet: &Pubkey, inviter: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::AcceptClubInvite {
            wallet: *wallet,
            club: *club,
            club_rules: rules_pda(),
            invite: pda(&[CLUB_INVITE_SEED, club.as_ref(), wallet.as_ref()]),
            inviter: *inviter,
            member: member_pda(club, wallet),
            system_program: system_program::ID,
        },
        outcomia::instruction::AcceptClubInvite {},
    )
}
fn promote(club: &Pubkey, owner: &Pubkey, wallet: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::SetClubMemberRole {
            owner: *owner,
            club: *club,
            member: member_pda(club, wallet),
            club_rules: rules_pda(),
        },
        outcomia::instruction::SetClubMemberRole {
            role: ClubRole::Admin,
        },
    )
}
fn nominate(club: &Pubkey, owner: &Pubkey, candidate: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::NominateClubOwner {
            owner: *owner,
            club: *club,
            candidate_member: member_pda(club, candidate),
        },
        outcomia::instruction::NominateClubOwner {},
    )
}
fn take_ownership(club: &Pubkey, candidate: &Pubkey, previous: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::AcceptClubOwnership {
            candidate: *candidate,
            club: *club,
            candidate_member: member_pda(club, candidate),
            club_rules: rules_pda(),
            candidate_record: record_pda(candidate),
            previous_record: record_pda(previous),
            system_program: system_program::ID,
        },
        outcomia::instruction::AcceptClubOwnership {},
    )
}
fn list(club: &Pubkey, owner: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::SetClubListing {
            owner: *owner,
            club: *club,
            listing: pda(&[CLUB_LISTING_SEED, club.as_ref()]),
            system_program: system_program::ID,
        },
        outcomia::instruction::SetClubListing {
            visibility: ClubVisibility::Public,
            topic: "Football".into(),
            description: "Matchday picks".into(),
        },
    )
}
fn migrate(sa: &Pubkey, club: &Pubkey, owner: &Pubkey, kind: ClubKind) -> Instruction {
    ix(
        outcomia::accounts::MigrateClub {
            super_admin: *sa,
            protocol_config: pda(&[PROTOCOL_CONFIG_SEED]),
            club: *club,
            listing: pda(&[CLUB_LISTING_SEED, club.as_ref()]),
            owner_record: record_pda(owner),
            system_program: system_program::ID,
        },
        outcomia::instruction::MigrateClub {
            kind,
            owner: *owner,
        },
    )
}

#[test]
fn only_the_super_admin_sets_nonzero_rules() {
    let mut f = Fixture::new();
    let other = f.wallet();
    f.fails(
        &other,
        set_rules(&other.pubkey(), 10, 10, 1, 1),
        "UnauthorizedSuperAdmin",
    );
    let sa = f.super_admin.insecure_clone();
    for (public, private, owned, admins) in [(0, 1, 1, 1), (1, 0, 1, 1), (1, 1, 0, 1), (1, 1, 1, 0)]
    {
        f.fails(
            &sa,
            set_rules(&sa.pubkey(), public, private, owned, admins),
            "InvalidClubRules",
        );
    }
    f.rules(100_000, 1_000, 2, 5);
    let rules: ClubRulesConfig = f.load(&rules_pda()).unwrap();
    assert_eq!(
        (
            rules.public_member_cap,
            rules.private_member_cap,
            rules.max_owned_clubs,
            rules.max_club_admins
        ),
        (100_000, 1_000, 2, 5)
    );
}

#[test]
fn clubs_need_rules_and_a_wallet_owns_at_most_the_limit() {
    let mut f = Fixture::new();
    let owner = f.wallet();
    // Without platform rules nothing can be created.
    f.fails(
        &owner,
        create(&owner.pubkey(), [1; 32], ClubKind::Private),
        "AccountNotInitialized",
    );
    f.rules(100_000, 1_000, 2, 5);
    let private = f.create(&owner, 1, ClubKind::Private);
    f.create(&owner, 2, ClubKind::Public);
    assert_eq!(f.owned(&owner.pubkey()), 2);
    assert_eq!(f.load::<Club>(&private).unwrap().kind, ClubKind::Private);
    f.fails(
        &owner,
        create(&owner.pubkey(), [3; 32], ClubKind::Public),
        "ClubOwnerLimitReached",
    );
    // Raising the limit lets the same wallet continue.
    f.rules(100_000, 1_000, 3, 5);
    f.create(&owner, 3, ClubKind::Public);
    assert_eq!(f.owned(&owner.pubkey()), 3);
}

#[test]
fn member_caps_follow_the_club_type_and_never_evict() {
    let mut f = Fixture::new();
    f.rules(3, 2, 2, 5);
    let owner = f.wallet();
    let private = f.create(&owner, 1, ClubKind::Private);
    let public = f.create(&owner, 2, ClubKind::Public);
    f.join(&private, &owner).unwrap();
    let logs = f.join(&private, &owner).unwrap_err();
    assert!(logs
        .iter()
        .any(|l| l.contains("Error Code: ClubMemberCapReached.")));
    f.join(&public, &owner).unwrap();
    f.join(&public, &owner).unwrap();
    assert!(f.join(&public, &owner).is_err());
    // Lowering the cap keeps current members; it only blocks new ones.
    f.rules(1, 1, 2, 5);
    assert_eq!(f.load::<Club>(&public).unwrap().member_count, 3);
    assert!(f.join(&public, &owner).is_err());
}

#[test]
fn admins_are_capped_including_the_owner() {
    let mut f = Fixture::new();
    f.rules(100, 100, 2, 2);
    let owner = f.wallet();
    let club = f.create(&owner, 1, ClubKind::Public);
    let (a, b) = (
        f.join(&club, &owner).unwrap(),
        f.join(&club, &owner).unwrap(),
    );
    f.ok(&owner, promote(&club, &owner.pubkey(), &a.pubkey()));
    f.fails(
        &owner,
        promote(&club, &owner.pubkey(), &b.pubkey()),
        "ClubAdminLimitReached",
    );
    assert_eq!(f.load::<Club>(&club).unwrap().admin_count, 2);
}

#[test]
fn only_public_clubs_can_be_listed() {
    let mut f = Fixture::new();
    f.rules(100, 100, 2, 5);
    let owner = f.wallet();
    let private = f.create(&owner, 1, ClubKind::Private);
    let public = f.create(&owner, 2, ClubKind::Public);
    f.fails(
        &owner,
        list(&private, &owner.pubkey()),
        "PrivateClubCannotList",
    );
    f.ok(&owner, list(&public, &owner.pubkey()));
}

#[test]
fn ownership_transfer_moves_the_owned_count_within_the_limit() {
    let mut f = Fixture::new();
    f.rules(100, 100, 1, 5);
    let owner = f.wallet();
    let club = f.create(&owner, 1, ClubKind::Public);
    let heir = f.join(&club, &owner).unwrap();
    // The heir already owns a club, so it cannot take a second one.
    f.create(&heir, 2, ClubKind::Private);
    f.ok(&owner, nominate(&club, &owner.pubkey(), &heir.pubkey()));
    f.fails(
        &heir,
        take_ownership(&club, &heir.pubkey(), &owner.pubkey()),
        "ClubOwnerLimitReached",
    );
    f.rules(100, 100, 2, 5);
    f.ok(
        &heir,
        take_ownership(&club, &heir.pubkey(), &owner.pubkey()),
    );
    assert_eq!(f.load::<Club>(&club).unwrap().owner, heir.pubkey());
    assert_eq!((f.owned(&heir.pubkey()), f.owned(&owner.pubkey())), (2, 0));
}

/// Layout of clubs created before club types, written as the old program did.
#[derive(AnchorSerialize)]
struct LegacyClub {
    club_id: [u8; 32],
    owner: Pubkey,
    pending_owner: Option<Pubkey>,
    name: String,
    market_policy: ClubMarketPolicy,
    member_count: u32,
    admin_count: u32,
    created_at: i64,
    bump: u8,
}

fn store_legacy_club(f: &mut Fixture, id: [u8; 32], owner: Pubkey) -> Pubkey {
    let (address, bump) = Pubkey::find_program_address(&[CLUB_SEED, &id], &outcomia::ID);
    let mut data = Club::DISCRIMINATOR.to_vec();
    LegacyClub {
        club_id: id,
        owner,
        pending_owner: None,
        name: "Legacy".into(),
        market_policy: ClubMarketPolicy::AdminsOnly,
        member_count: 4,
        admin_count: 1,
        created_at: 77,
        bump,
    }
    .serialize(&mut data)
    .unwrap();
    // The old program allocated the maximum legacy size.
    data.resize(8 + 32 + 32 + 33 + 4 + 64 + 1 + 4 + 4 + 8 + 1, 0);
    f.store(address, data);
    address
}

#[test]
fn the_super_admin_migrates_legacy_clubs_once() {
    let mut f = Fixture::new();
    f.rules(100, 100, 2, 5);
    let owner = f.wallet();
    let sa = f.super_admin.insecure_clone();
    let club = store_legacy_club(&mut f, [5; 32], owner.pubkey());
    let other = f.wallet();
    f.fails(
        &other,
        migrate(&other.pubkey(), &club, &owner.pubkey(), ClubKind::Public),
        "UnauthorizedSuperAdmin",
    );
    f.fails(
        &sa,
        migrate(&sa.pubkey(), &club, &other.pubkey(), ClubKind::Public),
        "InvalidClubMember",
    );
    f.ok(
        &sa,
        migrate(&sa.pubkey(), &club, &owner.pubkey(), ClubKind::Private),
    );
    let migrated: Club = f.load(&club).unwrap();
    assert_eq!(
        (
            migrated.kind,
            migrated.member_count,
            migrated.created_at,
            migrated.name.as_str()
        ),
        (ClubKind::Private, 4, 77, "Legacy")
    );
    assert_eq!(f.owned(&owner.pubkey()), 1);
    f.fails(
        &sa,
        migrate(&sa.pubkey(), &club, &owner.pubkey(), ClubKind::Private),
        "ClubMigrationNotNeeded",
    );
    assert_eq!(
        f.owned(&owner.pubkey()),
        1,
        "a repeat migration counts nothing"
    );
}

#[test]
fn a_listed_legacy_club_cannot_become_private() {
    let mut f = Fixture::new();
    f.rules(100, 100, 2, 5);
    let owner = f.wallet();
    let sa = f.super_admin.insecure_clone();
    let club = store_legacy_club(&mut f, [6; 32], owner.pubkey());
    let listing = pda(&[CLUB_LISTING_SEED, club.as_ref()]);
    let (_, bump) =
        Pubkey::find_program_address(&[CLUB_LISTING_SEED, club.as_ref()], &outcomia::ID);
    let mut data = Vec::new();
    ClubListing {
        club,
        visibility: ClubVisibility::Public,
        topic: "Topic".into(),
        description: String::new(),
        verified_by: None,
        updated_at: 0,
        bump,
    }
    .try_serialize(&mut data)
    .unwrap();
    f.store(listing, data);
    f.fails(
        &sa,
        migrate(&sa.pubkey(), &club, &owner.pubkey(), ClubKind::Private),
        "PrivateClubCannotList",
    );
    f.ok(
        &sa,
        migrate(&sa.pubkey(), &club, &owner.pubkey(), ClubKind::Public),
    );
    assert_eq!(f.load::<Club>(&club).unwrap().kind, ClubKind::Public);
}
