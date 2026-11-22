//! LiteSVM coverage for club creation, settings and membership lifecycle.

#![allow(clippy::result_large_err)]

use anchor_lang::{
    prelude::Pubkey, solana_program::instruction::Instruction, solana_program::system_program,
    AccountDeserialize, InstructionData, ToAccountMetas,
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
fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(outcomia::ID, &data.data(), accounts.to_account_metas(None))
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM_BYTES).unwrap();
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
            club,
            owner_member: member_pda(&club, owner),
            system_program: system_program::ID,
        },
        outcomia::instruction::CreateClub {
            club_id,
            name: name.into(),
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
