//! LiteSVM coverage for club rules milestone 2b: switching a club's type,
//! settling finished club markets and closing a club with its refund.

#![allow(clippy::result_large_err)]

#[path = "support/club_fixture.rs"]
mod club_fixture;
use club_fixture::*;

fn listing_pda(club: &Pubkey) -> Pubkey {
    pda(&[CLUB_LISTING_SEED, club.as_ref()])
}
fn club_market_pda(id: u8) -> Pubkey {
    pda(&[CLUB_MARKET_SEED, market_pda(&[id; 32]).as_ref()])
}
fn settlement_pda(id: u8) -> Pubkey {
    pda(&[CLUB_MARKET_SETTLED_SEED, club_market_pda(id).as_ref()])
}

/// USDC refund accounts, or none for a SOL or unpaid club.
#[derive(Clone, Copy)]
enum Refund {
    None,
    Usdc(Pubkey),
}

impl Fixture {
    fn set_kind(
        &self,
        club: Pubkey,
        kind: ClubKind,
        price: Option<Pubkey>,
        refund: Refund,
    ) -> Instruction {
        let (vault, token, program) = match refund {
            Refund::None => (None, None, None),
            Refund::Usdc(token) => (
                Some(vault_pda(&club)),
                Some(token),
                Some(anchor_spl::token::ID),
            ),
        };
        ix(
            outcomia::accounts::SetClubKind {
                owner: self.owner.pubkey(),
                club,
                club_rules: rules_pda(),
                listing: listing_pda(&club),
                price_update: price,
                deposit_vault: vault,
                owner_token: token,
                token_program: program,
            },
            outcomia::instruction::SetClubKind { kind },
        )
    }
    fn settle(&self, payer: &Pubkey, club: Pubkey, id: u8) -> Instruction {
        ix(
            outcomia::accounts::SettleClubMarket {
                payer: *payer,
                club,
                club_market: club_market_pda(id),
                market: market_pda(&[id; 32]),
                settlement: settlement_pda(id),
                system_program: system_program::ID,
            },
            outcomia::instruction::SettleClubMarket {},
        )
    }
    fn close(&self, club: Pubkey, refund: Refund) -> Instruction {
        let owner = self.owner.pubkey();
        let (vault, token, program) = match refund {
            Refund::None => (None, None, None),
            Refund::Usdc(token) => (
                Some(vault_pda(&club)),
                Some(token),
                Some(anchor_spl::token::ID),
            ),
        };
        ix(
            outcomia::accounts::CloseClub {
                owner,
                club,
                owner_record: pda(&[CLUB_OWNER_SEED, owner.as_ref()]),
                owner_member: member_pda(&club, &owner),
                listing: listing_pda(&club),
                deposit_vault: vault,
                owner_token: token,
                token_program: program,
            },
            outcomia::instruction::CloseClub {},
        )
    }
    fn list(&mut self, club: Pubkey) {
        let owner = self.owner.insecure_clone();
        self.ok(
            &owner,
            ix(
                outcomia::accounts::SetClubListing {
                    owner: owner.pubkey(),
                    club,
                    listing: listing_pda(&club),
                    system_program: system_program::ID,
                },
                outcomia::instruction::SetClubListing {
                    visibility: ClubVisibility::Public,
                    topic: "Football".into(),
                    description: "Fans".into(),
                },
            ),
        );
    }
    fn invite(&self, club: Pubkey, wallet: &Pubkey) -> Instruction {
        let inviter = self.owner.pubkey();
        ix(
            outcomia::accounts::InviteClubMember {
                inviter,
                club,
                inviter_member: member_pda(&club, &inviter),
                existing_member: member_pda(&club, wallet),
                invite: pda(&[CLUB_INVITE_SEED, club.as_ref(), wallet.as_ref()]),
                system_program: system_program::ID,
            },
            outcomia::instruction::InviteClubMember { wallet: *wallet },
        )
    }
    fn accept(&self, club: Pubkey, wallet: &Pubkey) -> Instruction {
        ix(
            outcomia::accounts::AcceptClubInvite {
                wallet: *wallet,
                club,
                club_rules: rules_pda(),
                invite: pda(&[CLUB_INVITE_SEED, club.as_ref(), wallet.as_ref()]),
                inviter: self.owner.pubkey(),
                member: member_pda(&club, wallet),
                system_program: system_program::ID,
            },
            outcomia::instruction::AcceptClubInvite {},
        )
    }
    fn promote(&self, club: Pubkey, wallet: &Pubkey) -> Instruction {
        ix(
            outcomia::accounts::SetClubMemberRole {
                owner: self.owner.pubkey(),
                club,
                member: member_pda(&club, wallet),
                club_rules: rules_pda(),
            },
            outcomia::instruction::SetClubMemberRole {
                role: ClubRole::Admin,
            },
        )
    }
    fn leave(&self, club: Pubkey, wallet: &Pubkey) -> Instruction {
        ix(
            outcomia::accounts::LeaveClub {
                wallet: *wallet,
                club,
                member: member_pda(&club, wallet),
            },
            outcomia::instruction::LeaveClub {},
        )
    }
    /// Rewrites a stored account with `edit` applied.
    fn edit<T: AccountDeserialize + AccountSerialize>(
        &mut self,
        address: Pubkey,
        edit: impl FnOnce(&mut T),
    ) {
        let mut value: T = self.load(&address);
        edit(&mut value);
        let mut account = self.svm.get_account(&address).unwrap();
        let mut data = Vec::new();
        value.try_serialize(&mut data).unwrap();
        account.data = data;
        self.svm.set_account(address, account).unwrap();
    }
    fn resolve(&mut self, id: u8) {
        self.edit::<PredictionMarket>(market_pda(&[id; 32]), |m| {
            m.status = PredictionStatus::Resolved
        });
    }
    fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map_or(0, |a| a.lamports)
    }
    fn exists(&self, address: &Pubkey) -> bool {
        self.svm
            .get_account(address)
            .is_some_and(|a| a.lamports > 0)
    }
    fn wallet(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), SOL).unwrap();
        k
    }
}

#[test]
fn private_clubs_become_public_only_at_the_public_payment_minimum() {
    let mut f = Fixture::new();
    f.configure();
    let club = f.create_club(1, ClubKind::Private);
    let owner = f.owner.insecure_clone();
    f.fails(
        &owner,
        f.set_kind(club, ClubKind::Public, None, Refund::None),
        "ClubDepositTooLow",
    );
    f.fund_usdc(club, 100_000_000);
    f.fails(
        &owner,
        f.set_kind(club, ClubKind::Private, None, Refund::None),
        "ClubKindUnchanged",
    );
    f.fails(
        &owner,
        f.set_kind(club, ClubKind::Public, None, Refund::None),
        "ClubDepositTooLow",
    );
    f.fund_usdc(club, 100_000_000);
    f.ok(
        &owner,
        f.set_kind(club, ClubKind::Public, None, Refund::None),
    );
    assert_eq!(f.club(1).kind, ClubKind::Public);
    let stranger = f.wallet();
    let mut ix = f.set_kind(club, ClubKind::Private, None, Refund::None);
    ix.accounts[0].pubkey = stranger.pubkey();
    f.fails(&stranger, ix, "UnauthorizedClubOwner");
}

#[test]
fn public_clubs_become_private_with_the_listing_removed_and_excess_refunded() {
    let mut f = Fixture::new();
    f.configure();
    let club = f.create_club(1, ClubKind::Public);
    f.fund_usdc(club, 250_000_000);
    f.list(club);
    assert!(f.exists(&listing_pda(&club)));
    let owner = f.owner.insecure_clone();
    // Too many members for a private club (cap 10 in the fixture).
    f.edit::<Club>(club, |c| c.member_count = 11);
    let token = f.token_account(&owner.pubkey(), 0);
    f.fails(
        &owner,
        f.set_kind(club, ClubKind::Private, None, Refund::Usdc(token)),
        "ClubTooLargeForPrivate",
    );
    f.edit::<Club>(club, |c| c.member_count = 1);
    f.fails(
        &owner,
        f.set_kind(club, ClubKind::Private, None, Refund::None),
        "ClubRefundAccountsMissing",
    );
    let rent_before = f.lamports(&owner.pubkey());
    f.ok(
        &owner,
        f.set_kind(club, ClubKind::Private, None, Refund::Usdc(token)),
    );
    let state = f.club(1);
    assert_eq!(
        (state.kind, state.deposit_amount),
        (ClubKind::Private, 100_000_000)
    );
    assert_eq!(f.token_amount(&token), 150_000_000);
    assert_eq!(f.token_amount(&vault_pda(&club)), 100_000_000);
    assert!(!f.exists(&listing_pda(&club)));
    // The listing's rent came back to the owner (less the transaction fee).
    assert!(f.lamports(&owner.pubkey()) > rent_before);
    // An unpaid public club becomes private with nothing to refund.
    let empty = f.create_club(2, ClubKind::Public);
    f.ok(
        &owner,
        f.set_kind(empty, ClubKind::Private, None, Refund::None),
    );
}

#[test]
fn sol_clubs_switch_at_the_current_price() {
    let mut f = Fixture::new();
    f.configure();
    let club = f.create_club(1, ClubKind::Public);
    let owner = f.owner.insecure_clone();
    let price = f.price_account(|_| {});
    f.ok(
        &owner,
        f.deposit_sol(&owner.pubkey(), club, price, 1_600_000_000),
    );
    f.fails(
        &owner,
        f.set_kind(club, ClubKind::Private, None, Refund::None),
        "ClubPriceUpdateRequired",
    );
    let before = f.lamports(&club);
    // A private club holds $120 = 0.8 SOL at $150; the other 0.8 SOL returns.
    f.ok(
        &owner,
        f.set_kind(club, ClubKind::Private, Some(price), Refund::None),
    );
    assert_eq!(before - f.lamports(&club), 800_000_000);
    assert_eq!(f.club(1).deposit_amount, 800_000_000);
    // Back to public needs 1.6 SOL again.
    f.fails(
        &owner,
        f.set_kind(club, ClubKind::Public, Some(price), Refund::None),
        "ClubDepositTooLow",
    );
}

#[test]
fn only_finished_markets_with_fees_withdrawn_are_settled_once() {
    let mut f = Fixture::new();
    f.configure();
    let club = f.create_club(1, ClubKind::Private);
    f.fund_usdc(club, 100_000_000);
    let owner = f.owner.insecure_clone();
    f.ok(&owner, f.create_market(club, 1, None));
    f.ok(&owner, f.open_market(club, 1, None));
    f.ok(&owner, f.create_market(club, 2, None));
    assert_eq!(f.club(1).live_markets, 2);
    let anyone = f.wallet();
    f.fails(
        &anyone,
        f.settle(&anyone.pubkey(), club, 1),
        "ClubMarketNotFinished",
    );
    f.resolve(1);
    f.edit::<ClubMarket>(club_market_pda(1), |m| m.accrued_club_fees = 10);
    f.fails(
        &anyone,
        f.settle(&anyone.pubkey(), club, 1),
        "ClubFeesNotWithdrawn",
    );
    f.edit::<ClubMarket>(club_market_pda(1), |m| m.accrued_club_fees = 0);
    f.ok(&anyone, f.settle(&anyone.pubkey(), club, 1));
    assert_eq!(f.club(1).live_markets, 1);
    let record: ClubMarketSettlement = f.load(&settlement_pda(1));
    assert_eq!(record.club_market, club_market_pda(1));
    assert!(f
        .send(&anyone, f.settle(&anyone.pubkey(), club, 1))
        .is_err());
    assert_eq!(f.club(1).live_markets, 1);
    // An unopened draft settles once its close time passes, while empty.
    f.fails(
        &anyone,
        f.settle(&anyone.pubkey(), club, 2),
        "ClubMarketNotFinished",
    );
    f.set_clock(NOW + 10_000);
    f.edit::<PredictionMarket>(market_pda(&[2; 32]), |m| m.yes_supply = 1);
    f.fails(
        &anyone,
        f.settle(&anyone.pubkey(), club, 2),
        "ClubMarketNotFinished",
    );
    f.edit::<PredictionMarket>(market_pda(&[2; 32]), |m| m.yes_supply = 0);
    f.ok(&anyone, f.settle(&anyone.pubkey(), club, 2));
    assert_eq!(f.club(1).live_markets, 0);
}

#[test]
fn a_market_from_another_club_cannot_settle_this_club() {
    let mut f = Fixture::new();
    f.configure();
    let a = f.create_club(1, ClubKind::Private);
    let b = f.create_club(2, ClubKind::Private);
    f.fund_usdc(a, 100_000_000);
    let owner = f.owner.insecure_clone();
    f.ok(&owner, f.create_market(a, 1, None));
    f.resolve(1);
    f.fails(&owner, f.settle(&owner.pubkey(), b, 1), "InvalidClubMarket");
}

#[test]
fn closing_refunds_usdc_frees_the_slot_and_freezes_the_club() {
    let mut f = Fixture::new();
    f.configure();
    let club = f.create_club(1, ClubKind::Public);
    f.fund_usdc(club, 200_000_000);
    f.list(club);
    let owner = f.owner.insecure_clone();
    let member = f.wallet();
    f.ok(&owner, f.invite(club, &member.pubkey()));
    f.ok(&member, f.accept(club, &member.pubkey()));
    f.ok(&owner, f.promote(club, &member.pubkey()));
    let late = f.wallet();
    f.ok(&owner, f.invite(club, &late.pubkey()));
    f.ok(&owner, f.create_market(club, 1, None));
    let token = f.token_account(&owner.pubkey(), 0);
    f.fails(
        &owner,
        f.close(club, Refund::Usdc(token)),
        "ClubHasLiveMarkets",
    );
    f.resolve(1);
    f.ok(&owner, f.settle(&owner.pubkey(), club, 1));
    f.fails(
        &owner,
        f.close(club, Refund::None),
        "ClubRefundAccountsMissing",
    );
    let record = pda(&[CLUB_OWNER_SEED, owner.pubkey().as_ref()]);
    let owned = f.load::<ClubOwnerRecord>(&record).owned;
    f.ok(&owner, f.close(club, Refund::Usdc(token)));

    assert_eq!(f.token_amount(&token), 200_000_000);
    assert!(!f.exists(&vault_pda(&club)));
    assert!(!f.exists(&listing_pda(&club)));
    assert!(!f.exists(&member_pda(&club, &owner.pubkey())));
    assert_eq!(f.load::<ClubOwnerRecord>(&record).owned, owned - 1);
    let state = f.club(1);
    assert!(state.closed);
    assert_eq!(
        (state.deposit_asset, state.deposit_amount),
        (ClubDepositAsset::None, 0)
    );
    assert_eq!((state.member_count, state.admin_count), (1, 1));

    // Nothing can join or change; members can still leave.
    f.fails(&late, f.accept(club, &late.pubkey()), "ClubClosed");
    let other = f.wallet();
    let mut invite = f.invite(club, &other.pubkey());
    invite.accounts[0].pubkey = member.pubkey();
    invite.accounts[2].pubkey = member_pda(&club, &member.pubkey());
    f.fails(&member, invite, "ClubClosed");
    let more = f.token_account(&owner.pubkey(), 200_000_000);
    f.fails(
        &owner,
        f.deposit_usdc(&owner.pubkey(), club, more, 200_000_000),
        "ClubClosed",
    );
    // The owner's membership is gone, so these fail before any club check.
    assert!(f.send(&owner, f.create_market(club, 2, None)).is_err());
    assert!(f.send(&owner, f.close(club, Refund::None)).is_err());
    f.ok(&member, f.leave(club, &member.pubkey()));
    assert_eq!(f.club(1).member_count, 0);
    // The freed slot lets the owner create a new club.
    f.create_club(3, ClubKind::Private);
}

#[test]
fn closing_a_sol_club_returns_the_deposit_and_keeps_the_rent() {
    let mut f = Fixture::new();
    f.configure();
    let club = f.create_club(1, ClubKind::Private);
    let owner = f.owner.insecure_clone();
    let price = f.price_account(|_| {});
    f.ok(&owner, f.deposit_sol(&owner.pubkey(), club, price, SOL));
    let before = f.lamports(&club);
    f.ok(&owner, f.close(club, Refund::None));
    assert_eq!(before - f.lamports(&club), SOL);
    let rent = f
        .svm
        .minimum_balance_for_rent_exemption(8 + Club::INIT_SPACE);
    assert_eq!(f.lamports(&club), rent);
}

#[test]
fn uncounted_or_foreign_clubs_cannot_close() {
    let mut f = Fixture::new();
    f.configure();
    let club = f.create_club(1, ClubKind::Private);
    let owner = f.owner.insecure_clone();
    f.edit::<Club>(club, |c| c.live_markets_ready = false);
    f.fails(&owner, f.close(club, Refund::None), "ClubMarketCountNotSet");
    f.edit::<Club>(club, |c| c.live_markets_ready = true);
    let stranger = f.wallet();
    let mut ix = f.close(club, Refund::None);
    ix.accounts[0].pubkey = stranger.pubkey();
    assert!(f.send(&stranger, ix).is_err());
    f.ok(&owner, f.close(club, Refund::None));
}
