//! LiteSVM coverage for club creation, settings and membership lifecycle.

#![allow(clippy::result_large_err)]

use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::Instruction, solana_program::system_program,
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
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
const CLUB_ID: [u8; 32] = [7; 32];

struct Fixture {
    svm: LiteSVM,
    owner: Keypair,
    club: Pubkey,
}

fn club_pda(id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[CLUB_SEED, id], &outcomia::ID).0
}
fn member_pda(club: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[CLUB_MEMBER_SEED, club.as_ref(), wallet.as_ref()],
        &outcomia::ID,
    )
    .0
}
fn invite_pda(club: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[CLUB_INVITE_SEED, club.as_ref(), wallet.as_ref()],
        &outcomia::ID,
    )
    .0
}
fn club_rules_pda() -> Pubkey {
    Pubkey::find_program_address(&[CLUB_RULES_CONFIG_SEED], &outcomia::ID).0
}
fn owner_record_pda(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CLUB_OWNER_SEED, wallet.as_ref()], &outcomia::ID).0
}
/// Writes the platform club rules directly, as the super-admin would set them.
fn install_club_rules(svm: &mut LiteSVM, public: u32, private: u32, owned: u16, admins: u16) {
    let (address, bump) = Pubkey::find_program_address(&[CLUB_RULES_CONFIG_SEED], &outcomia::ID);
    let mut data = Vec::new();
    ClubRulesConfig {
        public_member_cap: public,
        private_member_cap: private,
        max_owned_clubs: owned,
        max_club_admins: admins,
        bump,
        reserved: [0; 39],
        deposit_mint: Pubkey::default(),
        deposit_mint_decimals: 0,
        private_min_deposit_usd: 0,
        public_min_deposit_usd: 0,
        sol_buffer_bps: 0,
        sol_usd_feed_id: [0; 32],
        max_price_age_seconds: 0,
        max_price_conf_bps: 0,
    }
    .try_serialize(&mut data)
    .unwrap();
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(
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
fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(outcomia::ID, &data.data(), accounts.to_account_metas(None))
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM_BYTES).unwrap();
        install_club_rules(&mut svm, 100_000, 1_000, 2, 5);
        let owner = Keypair::new();
        svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
        let mut f = Fixture {
            svm,
            owner,
            club: club_pda(&CLUB_ID),
        };
        f.set_clock(1_000_000);
        let owner = f.owner.insecure_clone();
        f.ok(&owner, create_club(&owner.pubkey(), CLUB_ID, "Chess club"));
        f
    }
    fn wallet(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
        k
    }
    fn set_clock(&mut self, now: i64) {
        let mut c = self.svm.get_sysvar::<anchor_lang::prelude::Clock>();
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
    /// Fails with the named program or Anchor error, e.g. `InvalidClubName` or `ConstraintSeeds`.
    fn fails(&mut self, signer: &Keypair, ix: Instruction, error: &str) {
        let logs = self.send(signer, ix).expect_err("transaction should fail");
        let needle = format!("Error Code: {error}.");
        assert!(
            logs.iter().any(|l| l.contains(&needle)),
            "expected {error}: {logs:#?}"
        );
    }
    /// Fails for any reason (for example an address already in use).
    fn rejected(&mut self, signer: &Keypair, ix: Instruction) {
        assert!(self.send(signer, ix).is_err(), "transaction should fail");
    }
    fn load<T: AccountDeserialize>(&self, address: &Pubkey) -> Option<T> {
        let account = self.svm.get_account(address)?;
        if account.data.is_empty() {
            return None;
        }
        Some(T::try_deserialize(&mut account.data.as_slice()).unwrap())
    }
    fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map_or(0, |a| a.lamports)
    }
    /// Invites a fresh wallet and accepts as it, returning the new member.
    fn join(&mut self) -> Keypair {
        let owner = self.owner.insecure_clone();
        let wallet = self.wallet();
        self.ok(
            &owner,
            invite(&self.club, &owner.pubkey(), &wallet.pubkey()),
        );
        self.ok(
            &wallet,
            accept(&self.club, &wallet.pubkey(), &owner.pubkey()),
        );
        wallet
    }
    fn club(&self) -> Club {
        self.load(&self.club).unwrap()
    }
    fn member(&self, wallet: &Pubkey) -> Option<ClubMember> {
        self.load(&member_pda(&self.club, wallet))
    }
}

fn create_club(owner: &Pubkey, club_id: [u8; 32], name: &str) -> Instruction {
    let club = club_pda(&club_id);
    ix(
        outcomia::accounts::CreateClub {
            owner: *owner,
            club_rules: club_rules_pda(),
            owner_record: owner_record_pda(owner),
            club,
            owner_member: member_pda(&club, owner),
            system_program: system_program::ID,
        },
        outcomia::instruction::CreateClub {
            club_id,
            name: name.into(),
            kind: ClubKind::Public,
        },
    )
}
fn set_policy(club: &Pubkey, admin: &Pubkey, policy: ClubMarketPolicy) -> Instruction {
    ix(
        outcomia::accounts::ManageClub {
            admin: *admin,
            club: *club,
            admin_member: member_pda(club, admin),
        },
        outcomia::instruction::SetClubMarketPolicy { policy },
    )
}

#[test]
fn any_wallet_creates_a_club_and_becomes_its_admin_owner() {
    let f = Fixture::new();
    let club = f.club();
    assert_eq!(club.owner, f.owner.pubkey());
    assert_eq!(club.club_id, CLUB_ID);
    assert_eq!(club.name, "Chess club");
    assert_eq!(club.market_policy, ClubMarketPolicy::AdminsOnly);
    assert_eq!((club.member_count, club.admin_count), (1, 1));
    assert_eq!(club.pending_owner, None);
    assert_eq!(club.created_at, 1_000_000);
    let member = f.member(&f.owner.pubkey()).unwrap();
    assert_eq!(
        (member.club, member.wallet, member.role),
        (f.club, f.owner.pubkey(), ClubRole::Admin)
    );
}

#[test]
fn club_names_and_ids_are_validated() {
    let mut f = Fixture::new();
    let other = f.wallet();
    for name in ["", " padded", "trailing ", &"x".repeat(65)] {
        f.fails(
            &other,
            create_club(&other.pubkey(), [1; 32], name),
            "InvalidClubName",
        );
    }
    f.ok(
        &other,
        create_club(&other.pubkey(), [1; 32], &"x".repeat(64)),
    );
    // The id is taken, whoever asks.
    f.rejected(&other, create_club(&other.pubkey(), CLUB_ID, "Copy"));
}

#[test]
fn only_club_admins_change_the_market_policy() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let outsider = f.wallet();
    f.fails(
        &outsider,
        set_policy(&f.club, &outsider.pubkey(), ClubMarketPolicy::AnyMember),
        "AccountNotInitialized",
    );
    f.ok(
        &owner,
        set_policy(&f.club, &owner.pubkey(), ClubMarketPolicy::AnyMember),
    );
    assert_eq!(f.club().market_policy, ClubMarketPolicy::AnyMember);
}

fn invite(club: &Pubkey, inviter: &Pubkey, wallet: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::InviteClubMember {
            inviter: *inviter,
            club: *club,
            inviter_member: member_pda(club, inviter),
            existing_member: member_pda(club, wallet),
            invite: invite_pda(club, wallet),
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
            club_rules: club_rules_pda(),
            invite: invite_pda(club, wallet),
            inviter: *inviter,
            member: member_pda(club, wallet),
            system_program: system_program::ID,
        },
        outcomia::instruction::AcceptClubInvite {},
    )
}
fn close_invite(
    club: &Pubkey,
    wallet: &Pubkey,
    inviter: &Pubkey,
    closer: &Pubkey,
    as_member: bool,
) -> Instruction {
    ix(
        outcomia::accounts::CloseClubInvite {
            closer: *closer,
            invite: invite_pda(club, wallet),
            inviter: *inviter,
            closer_member: as_member.then(|| member_pda(club, closer)),
        },
        outcomia::instruction::CloseClubInvite {},
    )
}

#[test]
fn invited_wallet_joins_by_accepting_and_inviter_gets_rent_back() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let wallet = f.wallet();
    f.ok(&owner, invite(&f.club, &owner.pubkey(), &wallet.pubkey()));
    let stored: ClubInvite = f.load(&invite_pda(&f.club, &wallet.pubkey())).unwrap();
    assert_eq!(stored.expires_at, 1_000_000 + CLUB_INVITE_TTL_SECONDS);
    assert_eq!(
        (stored.club, stored.wallet, stored.inviter),
        (f.club, wallet.pubkey(), owner.pubkey())
    );
    assert_eq!(f.member(&wallet.pubkey()).map(|m| m.role), None);

    let before = f.lamports(&owner.pubkey());
    let rent = f.lamports(&invite_pda(&f.club, &wallet.pubkey()));
    f.set_clock(1_000_000 + CLUB_INVITE_TTL_SECONDS - 1);
    f.ok(&wallet, accept(&f.club, &wallet.pubkey(), &owner.pubkey()));
    assert_eq!(f.lamports(&owner.pubkey()), before + rent);
    assert_eq!(f.lamports(&invite_pda(&f.club, &wallet.pubkey())), 0);
    let member = f.member(&wallet.pubkey()).unwrap();
    assert_eq!(member.role, ClubRole::Member);
    assert_eq!(member.joined_at, 1_000_000 + CLUB_INVITE_TTL_SECONDS - 1);
    assert_eq!((f.club().member_count, f.club().admin_count), (2, 1));

    // Accepting happens exactly once.
    f.rejected(&wallet, accept(&f.club, &wallet.pubkey(), &owner.pubkey()));
}

#[test]
fn only_admins_invite_and_never_existing_members_or_twice() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let member = f.join();
    let outsider = f.wallet();
    let target = f.wallet();
    f.fails(
        &member,
        invite(&f.club, &member.pubkey(), &target.pubkey()),
        "UnauthorizedClubAdmin",
    );
    f.fails(
        &outsider,
        invite(&f.club, &outsider.pubkey(), &target.pubkey()),
        "AccountNotInitialized",
    );
    f.fails(
        &owner,
        invite(&f.club, &owner.pubkey(), &member.pubkey()),
        "AlreadyClubMember",
    );
    f.fails(
        &owner,
        invite(&f.club, &owner.pubkey(), &owner.pubkey()),
        "AlreadyClubMember",
    );
    f.ok(&owner, invite(&f.club, &owner.pubkey(), &target.pubkey()));
    f.rejected(&owner, invite(&f.club, &owner.pubkey(), &target.pubkey()));
}

#[test]
fn only_the_invited_wallet_accepts_and_only_before_expiry() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let wallet = f.wallet();
    let thief = f.wallet();
    f.ok(&owner, invite(&f.club, &owner.pubkey(), &wallet.pubkey()));
    // Another wallet cannot use the invitation: its own invite PDA does not exist.
    let mut stolen = accept(&f.club, &thief.pubkey(), &owner.pubkey());
    stolen.accounts[2].pubkey = invite_pda(&f.club, &wallet.pubkey());
    f.rejected(&thief, stolen);
    // Rent cannot be redirected.
    f.fails(
        &wallet,
        accept(&f.club, &wallet.pubkey(), &thief.pubkey()),
        "InvalidClubMember",
    );

    f.set_clock(1_000_000 + CLUB_INVITE_TTL_SECONDS);
    f.fails(
        &wallet,
        accept(&f.club, &wallet.pubkey(), &owner.pubkey()),
        "ClubInviteExpired",
    );
    assert!(f.member(&wallet.pubkey()).is_none());
}

#[test]
fn invitations_are_revoked_by_admins_declined_by_invitee_or_cleared_after_expiry() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let member = f.join();
    let (a, b, c) = (f.wallet(), f.wallet(), f.wallet());
    for w in [&a, &b, &c] {
        f.ok(&owner, invite(&f.club, &owner.pubkey(), &w.pubkey()));
    }
    let rent = f.lamports(&invite_pda(&f.club, &a.pubkey()));

    // Members who are not admins and outsiders cannot close an open invitation.
    f.fails(
        &member,
        close_invite(
            &f.club,
            &a.pubkey(),
            &owner.pubkey(),
            &member.pubkey(),
            true,
        ),
        "ClubInviteNotExpired",
    );
    f.fails(
        &b,
        close_invite(&f.club, &a.pubkey(), &owner.pubkey(), &b.pubkey(), false),
        "ClubInviteNotExpired",
    );
    // Rent goes only to the inviter.
    f.fails(
        &a,
        close_invite(&f.club, &a.pubkey(), &a.pubkey(), &a.pubkey(), false),
        "InvalidClubMember",
    );

    let before = f.lamports(&owner.pubkey());
    f.ok(
        &a,
        close_invite(&f.club, &a.pubkey(), &owner.pubkey(), &a.pubkey(), false),
    );
    assert_eq!(f.lamports(&owner.pubkey()), before + rent);
    assert!(f
        .svm
        .get_account(&invite_pda(&f.club, &a.pubkey()))
        .is_none_or(|x| x.data.is_empty()));

    // Any club admin (here the owner) revokes.
    f.ok(
        &owner,
        close_invite(&f.club, &b.pubkey(), &owner.pubkey(), &owner.pubkey(), true),
    );
    f.fails(
        &b,
        accept(&f.club, &b.pubkey(), &owner.pubkey()),
        "AccountNotInitialized",
    );

    // An admin of another club has no say here.
    let rival = f.wallet();
    f.ok(&rival, create_club(&rival.pubkey(), [9; 32], "Rival"));
    let mut foreign = close_invite(&f.club, &c.pubkey(), &owner.pubkey(), &rival.pubkey(), true);
    foreign.accounts[3].pubkey = member_pda(&club_pda(&[9; 32]), &rival.pubkey());
    f.fails(&rival, foreign, "ClubInviteNotExpired");

    f.set_clock(1_000_000 + CLUB_INVITE_TTL_SECONDS);
    f.ok(
        &rival,
        close_invite(
            &f.club,
            &c.pubkey(),
            &owner.pubkey(),
            &rival.pubkey(),
            false,
        ),
    );
    // A cleared invitation can be issued again.
    f.ok(&owner, invite(&f.club, &owner.pubkey(), &c.pubkey()));
}

fn set_role(club: &Pubkey, owner: &Pubkey, wallet: &Pubkey, role: ClubRole) -> Instruction {
    ix(
        outcomia::accounts::SetClubMemberRole {
            owner: *owner,
            club: *club,
            member: member_pda(club, wallet),
            club_rules: club_rules_pda(),
        },
        outcomia::instruction::SetClubMemberRole { role },
    )
}
fn remove(club: &Pubkey, admin: &Pubkey, wallet: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::RemoveClubMember {
            admin: *admin,
            club: *club,
            admin_member: member_pda(club, admin),
            member: member_pda(club, wallet),
            wallet: *wallet,
        },
        outcomia::instruction::RemoveClubMember {},
    )
}
fn leave(club: &Pubkey, wallet: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::LeaveClub {
            wallet: *wallet,
            club: *club,
            member: member_pda(club, wallet),
        },
        outcomia::instruction::LeaveClub {},
    )
}

#[test]
fn only_the_owner_promotes_and_demotes_admins() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let (a, b) = (f.join(), f.join());
    f.fails(
        &a,
        set_role(&f.club, &a.pubkey(), &b.pubkey(), ClubRole::Admin),
        "UnauthorizedClubOwner",
    );
    f.ok(
        &owner,
        set_role(&f.club, &owner.pubkey(), &a.pubkey(), ClubRole::Admin),
    );
    assert_eq!(f.member(&a.pubkey()).unwrap().role, ClubRole::Admin);
    assert_eq!((f.club().member_count, f.club().admin_count), (3, 2));
    // Even an admin cannot promote; repeating the current role changes nothing.
    f.fails(
        &a,
        set_role(&f.club, &a.pubkey(), &b.pubkey(), ClubRole::Admin),
        "UnauthorizedClubOwner",
    );
    f.ok(
        &owner,
        set_role(&f.club, &owner.pubkey(), &a.pubkey(), ClubRole::Admin),
    );
    assert_eq!(f.club().admin_count, 2);
    // The promoted admin can now invite.
    let c = f.wallet();
    f.ok(&a, invite(&f.club, &a.pubkey(), &c.pubkey()));
    f.ok(
        &owner,
        set_role(&f.club, &owner.pubkey(), &a.pubkey(), ClubRole::Member),
    );
    assert_eq!(f.club().admin_count, 1);
    f.fails(
        &owner,
        set_role(&f.club, &owner.pubkey(), &owner.pubkey(), ClubRole::Member),
        "ClubOwnerProtected",
    );
}

#[test]
fn admins_remove_members_and_only_the_owner_removes_admins() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let (admin, other_admin, member) = (f.join(), f.join(), f.join());
    for w in [&admin, &other_admin] {
        f.ok(
            &owner,
            set_role(&f.club, &owner.pubkey(), &w.pubkey(), ClubRole::Admin),
        );
    }
    f.fails(
        &member,
        remove(&f.club, &member.pubkey(), &admin.pubkey()),
        "UnauthorizedClubAdmin",
    );
    f.fails(
        &admin,
        remove(&f.club, &admin.pubkey(), &other_admin.pubkey()),
        "UnauthorizedClubOwner",
    );
    f.fails(
        &admin,
        remove(&f.club, &admin.pubkey(), &owner.pubkey()),
        "ClubOwnerProtected",
    );

    let before = f.lamports(&member.pubkey());
    let rent = f.lamports(&member_pda(&f.club, &member.pubkey()));
    f.ok(&admin, remove(&f.club, &admin.pubkey(), &member.pubkey()));
    assert_eq!(f.lamports(&member.pubkey()), before + rent);
    assert!(f.member(&member.pubkey()).is_none());
    assert_eq!((f.club().member_count, f.club().admin_count), (3, 3));

    f.ok(
        &owner,
        remove(&f.club, &owner.pubkey(), &other_admin.pubkey()),
    );
    assert_eq!((f.club().member_count, f.club().admin_count), (2, 2));
    // A removed wallet holds no club powers and can be invited again.
    f.fails(
        &other_admin,
        invite(&f.club, &other_admin.pubkey(), &member.pubkey()),
        "AccountNotInitialized",
    );
    f.ok(&admin, invite(&f.club, &admin.pubkey(), &member.pubkey()));
    f.ok(&member, accept(&f.club, &member.pubkey(), &admin.pubkey()));
    assert_eq!(f.member(&member.pubkey()).unwrap().role, ClubRole::Member);
}

#[test]
fn members_and_admins_leave_but_the_owner_cannot() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let (admin, member) = (f.join(), f.join());
    f.ok(
        &owner,
        set_role(&f.club, &owner.pubkey(), &admin.pubkey(), ClubRole::Admin),
    );
    f.fails(
        &owner,
        leave(&f.club, &owner.pubkey()),
        "ClubOwnerProtected",
    );
    f.ok(&member, leave(&f.club, &member.pubkey()));
    f.ok(&admin, leave(&f.club, &admin.pubkey()));
    assert_eq!((f.club().member_count, f.club().admin_count), (1, 1));
    let outsider = f.wallet();
    f.fails(
        &outsider,
        leave(&f.club, &outsider.pubkey()),
        "AccountNotInitialized",
    );
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
            club_rules: club_rules_pda(),
            candidate_record: owner_record_pda(candidate),
            previous_record: owner_record_pda(previous),
            system_program: system_program::ID,
        },
        outcomia::instruction::AcceptClubOwnership {},
    )
}

#[test]
fn ownership_moves_only_when_a_nominated_member_accepts() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let (heir, other) = (f.join(), f.join());
    let outsider = f.wallet();
    f.fails(
        &heir,
        nominate(&f.club, &heir.pubkey(), &heir.pubkey()),
        "UnauthorizedClubOwner",
    );
    f.fails(
        &owner,
        nominate(&f.club, &owner.pubkey(), &outsider.pubkey()),
        "AccountNotInitialized",
    );
    f.fails(
        &heir,
        take_ownership(&f.club, &heir.pubkey(), &owner.pubkey()),
        "InvalidClubMember",
    );

    f.ok(&owner, nominate(&f.club, &owner.pubkey(), &heir.pubkey()));
    assert_eq!(f.club().pending_owner, Some(heir.pubkey()));
    f.fails(
        &other,
        take_ownership(&f.club, &other.pubkey(), &owner.pubkey()),
        "InvalidClubMember",
    );
    // Nominating the owner cancels.
    f.ok(&owner, nominate(&f.club, &owner.pubkey(), &owner.pubkey()));
    assert_eq!(f.club().pending_owner, None);
    f.fails(
        &heir,
        take_ownership(&f.club, &heir.pubkey(), &owner.pubkey()),
        "InvalidClubMember",
    );

    f.ok(&owner, nominate(&f.club, &owner.pubkey(), &heir.pubkey()));
    f.ok(
        &heir,
        take_ownership(&f.club, &heir.pubkey(), &owner.pubkey()),
    );
    let club = f.club();
    assert_eq!((club.owner, club.pending_owner), (heir.pubkey(), None));
    assert_eq!((club.member_count, club.admin_count), (3, 2));
    assert_eq!(f.member(&heir.pubkey()).unwrap().role, ClubRole::Admin);
    assert_eq!(f.member(&owner.pubkey()).unwrap().role, ClubRole::Admin);

    // The former owner lost owner powers and may now leave; the new owner cannot.
    f.fails(
        &owner,
        set_role(&f.club, &owner.pubkey(), &other.pubkey(), ClubRole::Admin),
        "UnauthorizedClubOwner",
    );
    f.fails(&heir, leave(&f.club, &heir.pubkey()), "ClubOwnerProtected");
    f.ok(&owner, leave(&f.club, &owner.pubkey()));
    assert_eq!((f.club().member_count, f.club().admin_count), (2, 1));
}

#[test]
fn a_departing_nominee_cancels_the_nomination() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let (a, b) = (f.join(), f.join());
    f.ok(&owner, nominate(&f.club, &owner.pubkey(), &a.pubkey()));
    f.ok(&a, leave(&f.club, &a.pubkey()));
    assert_eq!(f.club().pending_owner, None);
    f.ok(&owner, nominate(&f.club, &owner.pubkey(), &b.pubkey()));
    f.ok(&owner, remove(&f.club, &owner.pubkey(), &b.pubkey()));
    assert_eq!(f.club().pending_owner, None);
    // Rejoining does not revive the old nomination.
    f.ok(&owner, invite(&f.club, &owner.pubkey(), &b.pubkey()));
    f.ok(&b, accept(&f.club, &b.pubkey(), &owner.pubkey()));
    f.fails(
        &b,
        take_ownership(&f.club, &b.pubkey(), &owner.pubkey()),
        "InvalidClubMember",
    );
}

fn fee_config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CLUB_FEE_CONFIG_SEED], &outcomia::ID).0
}
fn protocol_config_pda() -> Pubkey {
    Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &outcomia::ID).0
}
/// Stores a protocol config whose super-admin is `super_admin`.
fn store_protocol_config(f: &mut Fixture, super_admin: Pubkey) {
    let (address, bump) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &outcomia::ID);
    let mut data = Vec::new();
    ProtocolConfig {
        super_admin,
        taker_fee_bps: 0,
        bump,
    }
    .try_serialize(&mut data)
    .unwrap();
    let account = solana_account::Account {
        lamports: f.svm.minimum_balance_for_rent_exemption(data.len()),
        data,
        owner: outcomia::ID,
        executable: false,
        rent_epoch: 0,
    };
    f.svm.set_account(address, account).unwrap();
}
fn set_fee_share(super_admin: &Pubkey, club_share_bps: u16) -> Instruction {
    ix(
        outcomia::accounts::SetClubFeeShare {
            super_admin: *super_admin,
            protocol_config: protocol_config_pda(),
            club_fee_config: fee_config_pda(),
            system_program: system_program::ID,
        },
        outcomia::instruction::SetClubFeeShare { club_share_bps },
    )
}

#[test]
fn only_the_super_admin_sets_the_capped_club_fee_share() {
    let mut f = Fixture::new();
    let super_admin = f.wallet();
    store_protocol_config(&mut f, super_admin.pubkey());
    let owner = f.owner.insecure_clone();
    // Owning a club grants no protocol authority.
    f.fails(
        &owner,
        set_fee_share(&owner.pubkey(), 1_000),
        "UnauthorizedSuperAdmin",
    );
    f.fails(
        &super_admin,
        set_fee_share(&super_admin.pubkey(), 5_001),
        "ClubFeeShareTooHigh",
    );
    assert!(f.load::<ClubFeeConfig>(&fee_config_pda()).is_none());

    f.ok(&super_admin, set_fee_share(&super_admin.pubkey(), 2_000));
    assert_eq!(
        f.load::<ClubFeeConfig>(&fee_config_pda())
            .unwrap()
            .club_share_bps,
        2_000
    );
    f.ok(&super_admin, set_fee_share(&super_admin.pubkey(), 5_000));
    f.ok(&super_admin, set_fee_share(&super_admin.pubkey(), 0));
    assert_eq!(
        f.load::<ClubFeeConfig>(&fee_config_pda())
            .unwrap()
            .club_share_bps,
        0
    );
}
