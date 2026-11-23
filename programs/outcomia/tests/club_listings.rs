//! LiteSVM coverage for public and open clubs: listings, protocol-admin
//! verification, join requests and direct joins.

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
const CLUB_ID: [u8; 32] = [9; 32];
const NOW: i64 = 1_000_000;

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &outcomia::ID).0
}
fn club_pda() -> Pubkey {
    pda(&[CLUB_SEED, &CLUB_ID])
}
fn member_pda(club: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[CLUB_MEMBER_SEED, club.as_ref(), wallet.as_ref()])
}
fn listing_pda(club: &Pubkey) -> Pubkey {
    pda(&[CLUB_LISTING_SEED, club.as_ref()])
}
fn request_pda(club: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[CLUB_JOIN_REQUEST_SEED, club.as_ref(), wallet.as_ref()])
}
fn admin_pda(wallet: &Pubkey) -> Pubkey {
    pda(&[ADMIN_SEED, wallet.as_ref()])
}
fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(outcomia::ID, &data.data(), accounts.to_account_metas(None))
}

struct Fixture {
    svm: LiteSVM,
    owner: Keypair,
    protocol_admin: Keypair,
    club: Pubkey,
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM_BYTES).unwrap();
        let mut f = Fixture {
            svm,
            owner: Keypair::new(),
            protocol_admin: Keypair::new(),
            club: club_pda(),
        };
        for k in [f.owner.pubkey(), f.protocol_admin.pubkey()] {
            f.svm.airdrop(&k, 10_000_000_000).unwrap();
        }
        f.set_clock(NOW);
        let admin = f.protocol_admin.pubkey();
        f.store_admin(admin, AdminStatus::Active);
        let owner = f.owner.insecure_clone();
        f.ok(
            &owner,
            ix(
                outcomia::accounts::CreateClub {
                    owner: owner.pubkey(),
                    club: f.club,
                    owner_member: member_pda(&f.club, &owner.pubkey()),
                    system_program: system_program::ID,
                },
                outcomia::instruction::CreateClub {
                    club_id: CLUB_ID,
                    name: "Barcelona fans".into(),
                },
            ),
        );
        f
    }
    /// Stores a protocol admin record directly, as the admin flow is covered elsewhere.
    fn store_admin(&mut self, wallet: Pubkey, status: AdminStatus) {
        let (address, bump) =
            Pubkey::find_program_address(&[ADMIN_SEED, wallet.as_ref()], &outcomia::ID);
        let mut data = Vec::new();
        AdminRecord {
            authority: wallet,
            added_by: wallet,
            status,
            bump,
        }
        .try_serialize(&mut data)
        .unwrap();
        let account = solana_account::Account {
            lamports: self.svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: outcomia::ID,
            executable: false,
            rent_epoch: 0,
        };
        self.svm.set_account(address, account).unwrap();
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
    fn fails(&mut self, signer: &Keypair, ix: Instruction, error: &str) {
        let logs = self.send(signer, ix).expect_err("transaction should fail");
        let needle = format!("Error Code: {error}.");
        assert!(
            logs.iter().any(|l| l.contains(&needle)),
            "expected {error}: {logs:#?}"
        );
    }
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
    fn members(&self) -> u32 {
        self.load::<Club>(&self.club).unwrap().member_count
    }
    /// Lists the club with `visibility` and has the protocol admin verify it.
    fn list_verified(&mut self, visibility: ClubVisibility) {
        let owner = self.owner.insecure_clone();
        let admin = self.protocol_admin.insecure_clone();
        self.ok(
            &owner,
            set_listing(
                &self.club,
                &owner.pubkey(),
                visibility,
                "Football",
                "Fan club",
            ),
        );
        self.ok(&admin, verify(&self.club, &admin.pubkey(), true));
    }
}

fn set_listing(
    club: &Pubkey,
    owner: &Pubkey,
    visibility: ClubVisibility,
    topic: &str,
    description: &str,
) -> Instruction {
    ix(
        outcomia::accounts::SetClubListing {
            owner: *owner,
            club: *club,
            listing: listing_pda(club),
            system_program: system_program::ID,
        },
        outcomia::instruction::SetClubListing {
            visibility,
            topic: topic.into(),
            description: description.into(),
        },
    )
}
fn close_listing(club: &Pubkey, owner: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::CloseClubListing {
            owner: *owner,
            club: *club,
            listing: listing_pda(club),
        },
        outcomia::instruction::CloseClubListing {},
    )
}
fn verify(club: &Pubkey, authority: &Pubkey, verified: bool) -> Instruction {
    ix(
        outcomia::accounts::VerifyClubListing {
            authority: *authority,
            admin_record: admin_pda(authority),
            listing: listing_pda(club),
        },
        outcomia::instruction::VerifyClubListing { verified },
    )
}
fn request(club: &Pubkey, wallet: &Pubkey, note: &str) -> Instruction {
    ix(
        outcomia::accounts::RequestClubMembership {
            wallet: *wallet,
            club: *club,
            listing: listing_pda(club),
            existing_member: member_pda(club, wallet),
            request: request_pda(club, wallet),
            system_program: system_program::ID,
        },
        outcomia::instruction::RequestClubMembership { note: note.into() },
    )
}
fn approve(club: &Pubkey, admin: &Pubkey, wallet: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::ApproveClubRequest {
            admin: *admin,
            club: *club,
            admin_member: member_pda(club, admin),
            request: request_pda(club, wallet),
            wallet: *wallet,
            member: member_pda(club, wallet),
            system_program: system_program::ID,
        },
        outcomia::instruction::ApproveClubRequest {},
    )
}
fn close_request(club: &Pubkey, closer: &Pubkey, wallet: &Pubkey, as_admin: bool) -> Instruction {
    ix(
        outcomia::accounts::CloseClubRequest {
            closer: *closer,
            request: request_pda(club, wallet),
            wallet: *wallet,
            closer_member: as_admin.then(|| member_pda(club, closer)),
        },
        outcomia::instruction::CloseClubRequest {},
    )
}
fn join(club: &Pubkey, wallet: &Pubkey) -> Instruction {
    ix(
        outcomia::accounts::JoinOpenClub {
            wallet: *wallet,
            club: *club,
            listing: listing_pda(club),
            member: member_pda(club, wallet),
            system_program: system_program::ID,
        },
        outcomia::instruction::JoinOpenClub {},
    )
}

#[test]
fn only_the_owner_lists_and_terms_are_validated() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let stranger = f.wallet();
    f.fails(
        &stranger,
        set_listing(
            &f.club,
            &stranger.pubkey(),
            ClubVisibility::Public,
            "Football",
            "",
        ),
        "UnauthorizedClubOwner",
    );
    for (topic, description) in [("", "x"), (" Football", "x"), (&"t".repeat(33), "x")] {
        f.fails(
            &owner,
            set_listing(
                &f.club,
                &owner.pubkey(),
                ClubVisibility::Public,
                topic,
                description,
            ),
            "InvalidClubListing",
        );
    }
    f.fails(
        &owner,
        set_listing(
            &f.club,
            &owner.pubkey(),
            ClubVisibility::Public,
            "Football",
            &"d".repeat(281),
        ),
        "InvalidClubListing",
    );
    f.ok(
        &owner,
        set_listing(
            &f.club,
            &owner.pubkey(),
            ClubVisibility::Public,
            "Football",
            "Independent fan community",
        ),
    );
    let listing = f.load::<ClubListing>(&listing_pda(&f.club)).unwrap();
    assert_eq!(listing.visibility, ClubVisibility::Public);
    assert_eq!(listing.topic, "Football");
    assert!(listing.verified_by.is_none());
}

#[test]
fn only_active_protocol_admins_verify_and_any_change_clears_it() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let admin = f.protocol_admin.insecure_clone();
    f.ok(
        &owner,
        set_listing(
            &f.club,
            &owner.pubkey(),
            ClubVisibility::Open,
            "Football",
            "",
        ),
    );
    // Owning the club grants no protocol authority.
    f.rejected(&owner, verify(&f.club, &owner.pubkey(), true));
    let disabled = f.wallet();
    f.store_admin(disabled.pubkey(), AdminStatus::Disabled);
    f.fails(
        &disabled,
        verify(&f.club, &disabled.pubkey(), true),
        "AdminDisabled",
    );

    f.ok(&admin, verify(&f.club, &admin.pubkey(), true));
    assert_eq!(
        f.load::<ClubListing>(&listing_pda(&f.club))
            .unwrap()
            .verified_by,
        Some(admin.pubkey())
    );
    // Editing the terms (here the description) requires verification again.
    f.ok(
        &owner,
        set_listing(
            &f.club,
            &owner.pubkey(),
            ClubVisibility::Open,
            "Football",
            "New",
        ),
    );
    assert!(f
        .load::<ClubListing>(&listing_pda(&f.club))
        .unwrap()
        .verified_by
        .is_none());
    f.ok(&admin, verify(&f.club, &admin.pubkey(), true));
    f.ok(&admin, verify(&f.club, &admin.pubkey(), false));
    assert!(f
        .load::<ClubListing>(&listing_pda(&f.club))
        .unwrap()
        .verified_by
        .is_none());
}

#[test]
fn public_clubs_admit_by_request_and_admin_approval() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let fan = f.wallet();
    // Unlisted and unverified public clubs take no requests.
    f.rejected(&fan, request(&f.club, &fan.pubkey(), ""));
    f.ok(
        &owner,
        set_listing(
            &f.club,
            &owner.pubkey(),
            ClubVisibility::Public,
            "Football",
            "",
        ),
    );
    f.fails(&fan, request(&f.club, &fan.pubkey(), ""), "ClubNotPublic");
    let admin = f.protocol_admin.insecure_clone();
    f.ok(&admin, verify(&f.club, &admin.pubkey(), true));
    // Open joins are refused for a public club.
    f.fails(&fan, join(&f.club, &fan.pubkey()), "ClubNotOpen");
    f.fails(
        &fan,
        request(&f.club, &fan.pubkey(), &"n".repeat(141)),
        "InvalidClubListing",
    );

    f.ok(
        &fan,
        request(&f.club, &fan.pubkey(), "Season ticket holder"),
    );
    let pending = f
        .load::<ClubJoinRequest>(&request_pda(&f.club, &fan.pubkey()))
        .unwrap();
    assert_eq!(pending.note, "Season ticket holder");
    assert_eq!(pending.expires_at, NOW + CLUB_JOIN_REQUEST_TTL_SECONDS);
    f.rejected(&fan, request(&f.club, &fan.pubkey(), ""));

    // A non-admin member cannot approve.
    let stranger = f.wallet();
    f.rejected(
        &stranger,
        approve(&f.club, &stranger.pubkey(), &fan.pubkey()),
    );
    let fan_before = f.lamports(&fan.pubkey());
    let rent = f.lamports(&request_pda(&f.club, &fan.pubkey()));
    f.ok(&owner, approve(&f.club, &owner.pubkey(), &fan.pubkey()));
    assert_eq!(f.members(), 2);
    let member = f
        .load::<ClubMember>(&member_pda(&f.club, &fan.pubkey()))
        .unwrap();
    assert_eq!(member.role, ClubRole::Member);
    assert!(f
        .load::<ClubJoinRequest>(&request_pda(&f.club, &fan.pubkey()))
        .is_none());
    // The requester got the request rent back; the admin paid for the membership.
    assert_eq!(f.lamports(&fan.pubkey()), fan_before + rent);
    // Members cannot request again.
    f.fails(
        &fan,
        request(&f.club, &fan.pubkey(), ""),
        "AlreadyClubMember",
    );
}

#[test]
fn requests_expire_and_close_by_admin_requester_or_anyone_after_expiry() {
    let mut f = Fixture::new();
    f.list_verified(ClubVisibility::Public);
    let owner = f.owner.insecure_clone();
    let [a, b, c, stranger] = [f.wallet(), f.wallet(), f.wallet(), f.wallet()];
    for w in [&a, &b, &c] {
        f.ok(w, request(&f.club, &w.pubkey(), ""));
    }
    // A stranger cannot clear a live request; the requester cancels, an admin rejects.
    f.fails(
        &stranger,
        close_request(&f.club, &stranger.pubkey(), &a.pubkey(), false),
        "ClubJoinRequestNotExpired",
    );
    f.ok(&a, close_request(&f.club, &a.pubkey(), &a.pubkey(), false));
    f.ok(
        &owner,
        close_request(&f.club, &owner.pubkey(), &b.pubkey(), true),
    );
    assert!(f
        .load::<ClubJoinRequest>(&request_pda(&f.club, &a.pubkey()))
        .is_none());
    assert!(f
        .load::<ClubJoinRequest>(&request_pda(&f.club, &b.pubkey()))
        .is_none());

    // After seven days approval fails and anyone may clear the request.
    f.set_clock(NOW + CLUB_JOIN_REQUEST_TTL_SECONDS);
    f.fails(
        &owner,
        approve(&f.club, &owner.pubkey(), &c.pubkey()),
        "ClubJoinRequestExpired",
    );
    f.ok(
        &stranger,
        close_request(&f.club, &stranger.pubkey(), &c.pubkey(), false),
    );
    assert_eq!(f.members(), 1);
    // A rejected wallet may request again.
    f.ok(&b, request(&f.club, &b.pubkey(), ""));
}

#[test]
fn open_clubs_admit_directly_only_while_verified() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let fan = f.wallet();
    f.ok(
        &owner,
        set_listing(&f.club, &owner.pubkey(), ClubVisibility::Open, "F1", ""),
    );
    f.fails(&fan, join(&f.club, &fan.pubkey()), "ClubNotOpen");
    let admin = f.protocol_admin.insecure_clone();
    f.ok(&admin, verify(&f.club, &admin.pubkey(), true));
    // Requests are only for public clubs.
    f.fails(&fan, request(&f.club, &fan.pubkey(), ""), "ClubNotPublic");
    f.ok(&fan, join(&f.club, &fan.pubkey()));
    assert_eq!(f.members(), 2);
    f.rejected(&fan, join(&f.club, &fan.pubkey()));

    // Removing the listing makes the club private: no direct joins.
    f.ok(&owner, close_listing(&f.club, &owner.pubkey()));
    assert!(f.load::<ClubListing>(&listing_pda(&f.club)).is_none());
    let late = f.wallet();
    f.rejected(&late, join(&f.club, &late.pubkey()));
    let stranger = f.wallet();
    f.rejected(&stranger, close_listing(&f.club, &stranger.pubkey()));
}
