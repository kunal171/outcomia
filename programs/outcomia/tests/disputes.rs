//! LiteSVM coverage for outcome disputes (club rules milestone 3) on binary
//! markets: settings, the window, opening with a bond, eligible rulers,
//! rulings, expiry, and finalization held by a window or an open dispute.

#![allow(clippy::result_large_err)]

#[path = "support/club_fixture.rs"]
mod club_fixture;
use club_fixture::*;

/// Club dispute window and ruling deadline used by these tests.
const WINDOW: u64 = 500;
const DEADLINE: u64 = 1_000;
const MARKET: u8 = 1;
/// The fixture's club markets close at NOW + 10,000 and delay 10 seconds.
const PROPOSED_AT: i64 = NOW + 10_000;

fn market() -> Pubkey {
    market_pda(&[MARKET; 32])
}
fn record_pda() -> Pubkey {
    pda(&[MARKET_DISPUTE_SEED, market().as_ref()])
}
fn bond_pda() -> Pubkey {
    pda(&[DISPUTE_BOND_SEED, market().as_ref()])
}

/// A funded club with one open market, the owner as club admin.
struct Disputes {
    f: Fixture,
    club: Pubkey,
    treasury: Keypair,
}

impl Disputes {
    fn new() -> Self {
        let mut f = Fixture::new();
        f.configure();
        let club = f.create_club(1, ClubKind::Private);
        f.fund_usdc(club, 100_000_000);
        let owner = f.owner.insecure_clone();
        f.ok(&owner, f.create_market(club, MARKET, None));
        f.ok(&owner, f.open_market(club, MARKET, None));
        let mut d = Disputes {
            f,
            club,
            treasury: Keypair::new(),
        };
        let sa = d.f.super_admin.insecure_clone();
        let config = d.set_config(&sa.pubkey(), WINDOW, 100, 1, DEADLINE, d.treasury.pubkey());
        d.f.ok(&sa, config);
        d
    }
    fn set_config(
        &self,
        signer: &Pubkey,
        club_window: u64,
        regular_window: u64,
        bond: u64,
        deadline: u64,
        treasury: Pubkey,
    ) -> Instruction {
        ix(
            outcomia::accounts::SetDisputeConfig {
                super_admin: *signer,
                protocol_config: pda(&[PROTOCOL_CONFIG_SEED]),
                dispute_config: pda(&[DISPUTE_CONFIG_SEED]),
                system_program: system_program::ID,
            },
            outcomia::instruction::SetDisputeConfig {
                club_window_seconds: club_window,
                regular_window_seconds: regular_window,
                bond_tokens: bond,
                ruling_deadline_seconds: deadline,
                treasury,
            },
        )
    }
    fn propose(&self, outcome: PredictionResolution, correction: bool) -> Instruction {
        let admin = self.f.owner.pubkey();
        ix(
            outcomia::accounts::ProposeClubPrediction {
                admin,
                club_market: pda(&[CLUB_MARKET_SEED, market().as_ref()]),
                market: market(),
                admin_member: member_pda(&self.club, &admin),
                dispute_config: pda(&[DISPUTE_CONFIG_SEED]),
                dispute: record_pda(),
                system_program: system_program::ID,
            },
            outcomia::instruction::ProposeClubPrediction {
                outcome,
                evidence_uri: format!("ar://{}", "e".repeat(43)),
                evidence_hash: [5; 32],
                correction,
            },
        )
    }
    fn finalize(&self) -> Instruction {
        ix(
            outcomia::accounts::AdvanceClubPrediction {
                market: market(),
                dispute: record_pda(),
            },
            outcomia::instruction::AdvanceClubPrediction { action: 2 },
        )
    }
    /// Proposes YES right after trading closes.
    fn proposed(mut self) -> Self {
        self.f.set_clock(PROPOSED_AT);
        let owner = self.f.owner.insecure_clone();
        let ix = self.propose(PredictionResolution::Yes, false);
        self.f.ok(&owner, ix);
        self
    }
    /// A wallet holding `yes` contracts and 10 collateral tokens.
    fn holder(&mut self, yes: u64) -> (Keypair, Pubkey) {
        let wallet = Keypair::new();
        self.f.svm.airdrop(&wallet.pubkey(), SOL).unwrap();
        let (address, bump) = Pubkey::find_program_address(
            &[
                PREDICTION_POSITION_SEED,
                market().as_ref(),
                wallet.pubkey().as_ref(),
            ],
            &outcomia::ID,
        );
        let mut data = Vec::new();
        PredictionPosition {
            market: market(),
            owner: wallet.pubkey(),
            collateral_free: 0,
            collateral_locked: 0,
            yes_free: yes,
            yes_locked: 0,
            no_free: 0,
            no_locked: 0,
            bump,
        }
        .try_serialize(&mut data)
        .unwrap();
        self.f.store(address, data, outcomia::ID);
        let token = self.f.token_account(&wallet.pubkey(), 10_000_000);
        (wallet, token)
    }
    fn open(&self, disputer: &Pubkey, token: Pubkey) -> Instruction {
        ix(
            outcomia::accounts::OpenPredictionDispute {
                disputer: *disputer,
                market: market(),
                dispute: record_pda(),
                position: pda(&[
                    PREDICTION_POSITION_SEED,
                    market().as_ref(),
                    disputer.as_ref(),
                ]),
                dispute_config: pda(&[DISPUTE_CONFIG_SEED]),
                mint: self.f.mint,
                disputer_token: token,
                bond_vault: bond_pda(),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            },
            outcomia::instruction::OpenPredictionDispute {},
        )
    }
    /// A protocol admin, optionally also a club admin of the test club.
    fn admin(&mut self, club_admin: bool) -> Keypair {
        let admin = Keypair::new();
        self.f.svm.airdrop(&admin.pubkey(), SOL).unwrap();
        self.admin_record(&admin.pubkey());
        if club_admin {
            let (address, bump) = Pubkey::find_program_address(
                &[
                    CLUB_MEMBER_SEED,
                    self.club.as_ref(),
                    admin.pubkey().as_ref(),
                ],
                &outcomia::ID,
            );
            let mut data = Vec::new();
            ClubMember {
                club: self.club,
                wallet: admin.pubkey(),
                role: ClubRole::Admin,
                joined_at: NOW,
                bump,
            }
            .try_serialize(&mut data)
            .unwrap();
            self.f.store(address, data, outcomia::ID);
        }
        admin
    }
    fn admin_record(&mut self, wallet: &Pubkey) {
        let (address, bump) =
            Pubkey::find_program_address(&[ADMIN_SEED, wallet.as_ref()], &outcomia::ID);
        let mut data = Vec::new();
        AdminRecord {
            authority: *wallet,
            added_by: *wallet,
            status: AdminStatus::Active,
            bump,
        }
        .try_serialize(&mut data)
        .unwrap();
        self.f.store(address, data, outcomia::ID);
    }
    fn rule(
        &self,
        admin: &Pubkey,
        ruling: PredictionRuling,
        recipient: Pubkey,
        disputer: Pubkey,
    ) -> Instruction {
        ix(
            outcomia::accounts::RulePredictionDispute {
                admin: *admin,
                admin_record: pda(&[ADMIN_SEED, admin.as_ref()]),
                market: market(),
                dispute: record_pda(),
                dispute_config: pda(&[DISPUTE_CONFIG_SEED]),
                club_market: pda(&[CLUB_MARKET_SEED, market().as_ref()]),
                admin_club_member: member_pda(&self.club, admin),
                bond_vault: bond_pda(),
                recipient,
                disputer,
                token_program: anchor_spl::token::ID,
            },
            outcomia::instruction::RulePredictionDispute { ruling },
        )
    }
    fn expire(&self, recipient: Pubkey, disputer: Pubkey) -> Instruction {
        ix(
            outcomia::accounts::ExpirePredictionDispute {
                market: market(),
                dispute: record_pda(),
                bond_vault: bond_pda(),
                recipient,
                disputer,
                token_program: anchor_spl::token::ID,
            },
            outcomia::instruction::ExpirePredictionDispute {},
        )
    }
    fn record(&self) -> MarketDispute {
        self.f.load(&record_pda())
    }
    fn market(&self) -> PredictionMarket {
        self.f.load(&market())
    }
    /// Proposed YES, disputed by a 5-contract holder; returns the disputer and
    /// their token account.
    fn disputed() -> (Self, Keypair, Pubkey) {
        let mut d = Disputes::new().proposed();
        let (disputer, token) = d.holder(5);
        let ix = d.open(&disputer.pubkey(), token);
        d.f.ok(&disputer, ix);
        (d, disputer, token)
    }
}

#[test]
fn only_the_super_admin_sets_valid_dispute_settings() {
    let mut d = Disputes::new();
    let owner = d.f.owner.insecure_clone();
    let treasury = d.treasury.pubkey();
    let ix = d.set_config(&owner.pubkey(), 1, 1, 1, 1, treasury);
    d.f.fails(&owner, ix, "UnauthorizedSuperAdmin");
    let sa = d.f.super_admin.insecure_clone();
    let month = 30 * 24 * 60 * 60;
    for (club, regular, bond, deadline, treasury) in [
        (0, 1, 1, 1, treasury),
        (1, 0, 1, 1, treasury),
        (1, 1, 0, 1, treasury),
        (1, 1, 1, 0, treasury),
        (month + 1, 1, 1, 1, treasury),
        (1, 1, 1, 1, Pubkey::default()),
    ] {
        let ix = d.set_config(&sa.pubkey(), club, regular, bond, deadline, treasury);
        d.f.fails(&sa, ix, "InvalidDisputeConfig");
    }
    let config: DisputeConfig = d.f.load(&pda(&[DISPUTE_CONFIG_SEED]));
    assert_eq!(
        (
            config.club_window_seconds,
            config.regular_window_seconds,
            config.bond_tokens
        ),
        (WINDOW, 100, 1)
    );
    assert_eq!(config.treasury, d.treasury.pubkey());
}

#[test]
fn a_club_proposal_records_the_club_window_and_holds_finalization() {
    let mut d = Disputes::new().proposed();
    let record = d.record();
    assert_eq!(
        (
            record.market,
            record.window_seconds,
            record.club_market,
            record.state
        ),
        (market(), WINDOW, true, DisputeState::None)
    );
    let anyone = d.f.owner.insecure_clone();
    // The 10-second review delay has passed, but not the 500-second window.
    d.f.set_clock(PROPOSED_AT + 10);
    let ix = d.finalize();
    d.f.fails(&anyone, ix, "DisputeWindowOpen");
    // A correction (inside the review delay) restarts the window.
    d.f.set_clock(PROPOSED_AT + 5);
    let ix = d.propose(PredictionResolution::No, true);
    d.f.ok(&anyone, ix);
    d.f.set_clock(PROPOSED_AT + WINDOW as i64);
    let ix = d.finalize();
    d.f.fails(&anyone, ix, "DisputeWindowOpen");
    d.f.set_clock(PROPOSED_AT + 5 + WINDOW as i64);
    let ix = d.finalize();
    d.f.ok(&anyone, ix);
    let m = d.market();
    assert_eq!(
        (m.status, m.final_outcome),
        (PredictionStatus::Resolved, Some(PredictionResolution::No))
    );
}

#[test]
fn holders_open_one_dispute_inside_the_window_with_a_bond() {
    let mut d = Disputes::new();
    let (holder, token) = d.holder(5);
    // Before any proposal there is no record to dispute.
    let ix = d.open(&holder.pubkey(), token);
    assert!(d.f.send(&holder, ix).is_err());
    d = d.proposed();
    let (empty, empty_token) = d.holder(0);
    let ix = d.open(&empty.pubkey(), empty_token);
    d.f.fails(&empty, ix, "DisputerHoldsNothing");
    let ix = d.open(&holder.pubkey(), token);
    d.f.ok(&holder, ix);
    // One whole token at 6 decimals.
    assert_eq!(d.f.token_amount(&bond_pda()), 1_000_000);
    assert_eq!(d.f.token_amount(&token), 9_000_000);
    let record = d.record();
    assert_eq!(
        (record.state, record.disputer, record.bond_amount),
        (DisputeState::Open, holder.pubkey(), 1_000_000)
    );
    assert_eq!(record.ruling_deadline, PROPOSED_AT + DEADLINE as i64);
    // A second dispute, finalization and corrections all wait for the ruling.
    let (other, other_token) = d.holder(3);
    let ix = d.open(&other.pubkey(), other_token);
    d.f.fails(&other, ix, "DisputeUnavailable");
    let owner = d.f.owner.insecure_clone();
    d.f.set_clock(PROPOSED_AT + 10 + WINDOW as i64);
    let ix = d.finalize();
    d.f.fails(&owner, ix, "DisputeOpen");
    let ix = d.propose(PredictionResolution::No, true);
    assert!(d.f.send(&owner, ix).is_err());
}

#[test]
fn disputes_close_with_the_window() {
    let mut d = Disputes::new().proposed();
    let (holder, token) = d.holder(5);
    d.f.set_clock(PROPOSED_AT + WINDOW as i64);
    let ix = d.open(&holder.pubkey(), token);
    d.f.fails(&holder, ix, "DisputeUnavailable");
}

#[test]
fn creators_resolvers_and_club_admins_cannot_rule() {
    let (mut d, disputer, token) = Disputes::disputed();
    let treasury_token = d.f.token_account(&d.treasury.pubkey(), 0);
    // The owner created the market and, as club admin, resolves it.
    let owner = d.f.owner.insecure_clone();
    d.admin_record(&owner.pubkey());
    let ix = d.rule(
        &owner.pubkey(),
        PredictionRuling::Uphold,
        treasury_token,
        disputer.pubkey(),
    );
    d.f.fails(&owner, ix, "IneligibleDisputeRuler");
    let club_admin = d.admin(true);
    let ix = d.rule(
        &club_admin.pubkey(),
        PredictionRuling::Uphold,
        treasury_token,
        disputer.pubkey(),
    );
    d.f.fails(&club_admin, ix, "IneligibleDisputeRuler");
    // A wallet without an admin record is not an admin at all.
    let stranger = Keypair::new();
    d.f.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let ix = d.rule(
        &stranger.pubkey(),
        PredictionRuling::Uphold,
        treasury_token,
        disputer.pubkey(),
    );
    assert!(d.f.send(&stranger, ix).is_err());
    // An upheld bond goes only to the treasury.
    let admin = d.admin(false);
    let ix = d.rule(
        &admin.pubkey(),
        PredictionRuling::Uphold,
        token,
        disputer.pubkey(),
    );
    d.f.fails(&admin, ix, "InvalidBondRecipient");
}

#[test]
fn an_upheld_dispute_finalizes_the_proposal_and_pays_the_treasury() {
    let (mut d, disputer, _) = Disputes::disputed();
    let treasury_token = d.f.token_account(&d.treasury.pubkey(), 0);
    let admin = d.admin(false);
    let ix = d.rule(
        &admin.pubkey(),
        PredictionRuling::Uphold,
        treasury_token,
        disputer.pubkey(),
    );
    d.f.ok(&admin, ix);
    assert_eq!(d.f.token_amount(&treasury_token), 1_000_000);
    assert!(d
        .f
        .svm
        .get_account(&bond_pda())
        .is_none_or(|a| a.lamports == 0));
    let m = d.market();
    assert_eq!(
        (m.status, m.final_outcome),
        (PredictionStatus::Resolved, Some(PredictionResolution::Yes))
    );
    let record = d.record();
    assert_eq!(record.state, DisputeState::Upheld);
    assert_eq!(record.ruled_by, Some(admin.pubkey()));
    assert!(!record.club_penalty_due);
    // The ruling is final (the bond vault is closed too).
    let ix = d.rule(
        &admin.pubkey(),
        PredictionRuling::Invalid,
        treasury_token,
        disputer.pubkey(),
    );
    assert!(d.f.send(&admin, ix).is_err());
    assert_eq!(d.record().state, DisputeState::Upheld);
}

#[test]
fn overturned_and_invalid_rulings_refund_the_bond_and_mark_the_club_penalty() {
    for (ruling, outcome, state) in [
        (
            PredictionRuling::Overturn(PredictionResolution::No),
            PredictionResolution::No,
            DisputeState::Overturned,
        ),
        (
            PredictionRuling::Invalid,
            PredictionResolution::Invalid,
            DisputeState::Invalidated,
        ),
    ] {
        let (mut d, disputer, token) = Disputes::disputed();
        let admin = d.admin(false);
        for bad in [
            PredictionRuling::Overturn(PredictionResolution::Yes),
            PredictionRuling::Overturn(PredictionResolution::Invalid),
        ] {
            let ix = d.rule(&admin.pubkey(), bad, token, disputer.pubkey());
            d.f.fails(&admin, ix, "InvalidDisputeRuling");
        }
        let ix = d.rule(&admin.pubkey(), ruling, token, disputer.pubkey());
        d.f.ok(&admin, ix);
        assert_eq!(d.f.token_amount(&token), 10_000_000);
        let m = d.market();
        assert_eq!(
            (m.status, m.final_outcome),
            (PredictionStatus::Resolved, Some(outcome))
        );
        let record = d.record();
        assert_eq!(record.state, state);
        assert!(record.club_penalty_due);
    }
}

#[test]
fn an_unruled_dispute_expires_to_invalid_without_a_penalty() {
    let (mut d, disputer, token) = Disputes::disputed();
    let anyone = d.f.owner.insecure_clone();
    let deadline = PROPOSED_AT + DEADLINE as i64;
    d.f.set_clock(deadline - 1);
    let ix = d.expire(token, disputer.pubkey());
    d.f.fails(&anyone, ix, "DisputeRulingNotExpired");
    // The refund goes only to the disputer.
    let other = d.f.token_account(&anyone.pubkey(), 0);
    d.f.set_clock(deadline);
    let ix = d.expire(other, disputer.pubkey());
    d.f.fails(&anyone, ix, "InvalidBondRecipient");
    let admin = d.admin(false);
    let ix = d.rule(
        &admin.pubkey(),
        PredictionRuling::Uphold,
        token,
        disputer.pubkey(),
    );
    d.f.fails(&admin, ix, "DisputeRulingExpired");
    let ix = d.expire(token, disputer.pubkey());
    d.f.ok(&anyone, ix);
    assert_eq!(d.f.token_amount(&token), 10_000_000);
    let m = d.market();
    assert_eq!(
        (m.status, m.final_outcome),
        (
            PredictionStatus::Resolved,
            Some(PredictionResolution::Invalid)
        )
    );
    let record = d.record();
    assert_eq!(record.state, DisputeState::Expired);
    assert!(!record.club_penalty_due);
}
