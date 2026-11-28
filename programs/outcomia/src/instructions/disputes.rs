//! Outcome disputes on prediction markets (club rules milestone 3).
//!
//! Every proposal creates (or reuses) the market's dispute record, which fixes
//! the dispute window: the club window for club markets, the regular one for
//! all others. Finalization waits for both the review delay and that window.
//!
//! During the window any holder of the market's contracts may open one
//! dispute, posting a bond of whole collateral tokens. Trading has already
//! closed by then, so a dispute only holds finalization (and with it
//! redemption) and the resolver's corrections. An eligible protocol admin
//! rules before the deadline; otherwise anyone can expire the dispute and the
//! market becomes invalid. Every ruling is final.

use anchor_lang::prelude::*;
use anchor_spl::token::{
    close_account, transfer, CloseAccount, Mint, Token, TokenAccount, Transfer,
};

use crate::{
    constants::*,
    errors::{admin, dispute, multi_outcome as multi_errors},
    resolution::{self, DisputeGate, ResolutionMarket},
    state::*,
};

// ----- Settings -----

#[derive(Accounts)]
pub struct SetDisputeConfig<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump,
        has_one = super_admin @ admin::UnauthorizedSuperAdmin)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(init_if_needed, payer = super_admin, space = 8 + DisputeConfig::INIT_SPACE,
        seeds = [DISPUTE_CONFIG_SEED], bump)]
    pub dispute_config: Account<'info, DisputeConfig>,
    pub system_program: Program<'info, System>,
}

/// Creates or updates the dispute settings.
///
/// # Inputs
/// The super-admin (paying rent on first use), both windows and the ruling
/// deadline in seconds, the bond in whole tokens and the treasury wallet.
/// # Errors
/// Not the super-admin; a period outside 1 second to 30 days; a zero bond; or
/// a default treasury.
/// # Returns
/// `Ok(())`. New values apply to later proposals and disputes only.
pub fn handle_set_dispute_config(
    ctx: Context<SetDisputeConfig>,
    club_window_seconds: u64,
    regular_window_seconds: u64,
    bond_tokens: u64,
    ruling_deadline_seconds: u64,
    treasury: Pubkey,
) -> Result<()> {
    let period = 1..=MAX_DISPUTE_PERIOD_SECONDS;
    require!(
        period.contains(&club_window_seconds)
            && period.contains(&regular_window_seconds)
            && period.contains(&ruling_deadline_seconds)
            && bond_tokens >= 1
            && treasury != Pubkey::default(),
        dispute::InvalidDisputeConfig
    );
    let config = &mut ctx.accounts.dispute_config;
    config.club_window_seconds = club_window_seconds;
    config.regular_window_seconds = regular_window_seconds;
    config.bond_tokens = bond_tokens;
    config.ruling_deadline_seconds = ruling_deadline_seconds;
    config.treasury = treasury;
    config.bump = ctx.bumps.dispute_config;
    Ok(())
}

// ----- Shared by proposals and finalization -----

/// Prepares a market's dispute record for a (corrected) proposal: a new record
/// takes the window for its kind of market; an open dispute blocks the resolver.
pub(crate) fn prepare_proposal(
    record: &mut MarketDispute,
    market: Pubkey,
    club_market: bool,
    config: &DisputeConfig,
    bump: u8,
) -> Result<()> {
    if record.market == Pubkey::default() {
        record.market = market;
        record.club_market = club_market;
        record.window_seconds = if club_market {
            config.club_window_seconds
        } else {
            config.regular_window_seconds
        };
        record.state = DisputeState::None;
        record.bump = bump;
    }
    require_keys_eq!(record.market, market, dispute::DisputeUnavailable);
    require!(record.state != DisputeState::Open, dispute::DisputeOpen);
    Ok(())
}

/// Reads the finalization gate from a market's dispute-record address.
/// An empty address means the proposal predates disputes: the old rule applies.
pub(crate) fn gate(record: &AccountInfo) -> Result<Option<DisputeGate>> {
    if record.data_is_empty() {
        return Ok(None);
    }
    require_keys_eq!(*record.owner, crate::ID, dispute::DisputeUnavailable);
    let data = record.try_borrow_data()?;
    let record = MarketDispute::try_deserialize(&mut &data[..])?;
    Ok(Some(DisputeGate {
        window_seconds: record.window_seconds,
        open: record.state == DisputeState::Open,
    }))
}

// ----- Opening -----

/// Opens a dispute: checks the window and posts the bond.
#[allow(clippy::too_many_arguments)]
fn open<'info, M: ResolutionMarket>(
    market: &M,
    record: &mut MarketDispute,
    config: &DisputeConfig,
    mint: &Account<'info, Mint>,
    disputer: &Signer<'info>,
    disputer_token: &Account<'info, TokenAccount>,
    bond_vault: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    holds_contracts: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        market.status() == PredictionStatus::Proposed
            && market.final_outcome().is_none()
            && record.state == DisputeState::None
            && now < resolution::dispute_window_end(market, record.window_seconds)?,
        dispute::DisputeUnavailable
    );
    require!(holds_contracts, dispute::DisputerHoldsNothing);
    let bond = config
        .bond_tokens
        .checked_mul(
            10u64
                .checked_pow(mint.decimals as u32)
                .ok_or(dispute::InvalidDisputeConfig)?,
        )
        .ok_or(dispute::InvalidDisputeConfig)?;
    transfer(
        CpiContext::new(
            token_program.key(),
            Transfer {
                from: disputer_token.to_account_info(),
                to: bond_vault.to_account_info(),
                authority: disputer.to_account_info(),
            },
        ),
        bond,
    )?;
    let deadline = i64::try_from(config.ruling_deadline_seconds)
        .ok()
        .and_then(|d| now.checked_add(d))
        .ok_or(dispute::InvalidDisputeConfig)?;
    record.state = DisputeState::Open;
    record.disputer = disputer.key();
    record.bond_mint = mint.key();
    record.bond_amount = bond;
    record.opened_at = now;
    record.ruling_deadline = deadline;
    Ok(())
}

#[derive(Accounts)]
pub struct OpenPredictionDispute<'info> {
    #[account(mut)]
    pub disputer: Signer<'info>,
    /// A public or club binary market; the record and position derive from it.
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut, seeds = [MARKET_DISPUTE_SEED, market.key().as_ref()], bump = dispute.bump)]
    pub dispute: Box<Account<'info, MarketDispute>>,
    #[account(seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), disputer.key().as_ref()],
        bump = position.bump)]
    pub position: Box<Account<'info, PredictionPosition>>,
    #[account(seeds = [DISPUTE_CONFIG_SEED], bump = dispute_config.bump)]
    pub dispute_config: Box<Account<'info, DisputeConfig>>,
    #[account(address = market.collateral_mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = disputer)]
    pub disputer_token: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = disputer,
        seeds = [DISPUTE_BOND_SEED, market.key().as_ref()], bump,
        token::mint = mint, token::authority = dispute)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Disputes a binary market's pending proposal.
///
/// # Inputs
/// A holder of the market's contracts, the market, its dispute record, the
/// holder's position, the dispute settings, the collateral mint, the holder's
/// token account and the bond vault (created here).
/// # Errors
/// No pending proposal, the window has ended, the market was already disputed,
/// the position is empty, or the bond cannot be paid.
/// # Returns
/// `Ok(())` with the bond held and the dispute open.
pub fn handle_open_prediction_dispute(ctx: Context<OpenPredictionDispute>) -> Result<()> {
    let p = &ctx.accounts.position;
    let holds = [p.yes_free, p.yes_locked, p.no_free, p.no_locked]
        .iter()
        .any(|&n| n > 0);
    open(
        &**ctx.accounts.market,
        &mut ctx.accounts.dispute,
        &ctx.accounts.dispute_config,
        &ctx.accounts.mint,
        &ctx.accounts.disputer,
        &ctx.accounts.disputer_token,
        &ctx.accounts.bond_vault,
        &ctx.accounts.token_program,
        holds,
    )
}

#[derive(Accounts)]
pub struct OpenMultiOutcomeDispute<'info> {
    #[account(mut)]
    pub disputer: Signer<'info>,
    #[account(seeds = [MULTI_OUTCOME_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(mut, seeds = [MARKET_DISPUTE_SEED, market.key().as_ref()], bump = dispute.bump)]
    pub dispute: Box<Account<'info, MarketDispute>>,
    #[account(seeds = [MULTI_OUTCOME_POSITION_SEED, market.key().as_ref(), disputer.key().as_ref()],
        bump = position.bump)]
    pub position: Box<Account<'info, MultiOutcomePosition>>,
    #[account(seeds = [DISPUTE_CONFIG_SEED], bump = dispute_config.bump)]
    pub dispute_config: Box<Account<'info, DisputeConfig>>,
    #[account(address = market.collateral_mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = disputer)]
    pub disputer_token: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = disputer,
        seeds = [DISPUTE_BOND_SEED, market.key().as_ref()], bump,
        token::mint = mint, token::authority = dispute)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Disputes a multi-outcome market's pending proposal. Same rules as binary.
pub fn handle_open_multi_outcome_dispute(ctx: Context<OpenMultiOutcomeDispute>) -> Result<()> {
    let p = &ctx.accounts.position;
    let holds = p.free.iter().chain(p.locked.iter()).any(|&n| n > 0);
    open(
        &**ctx.accounts.market,
        &mut ctx.accounts.dispute,
        &ctx.accounts.dispute_config,
        &ctx.accounts.mint,
        &ctx.accounts.disputer,
        &ctx.accounts.disputer_token,
        &ctx.accounts.bond_vault,
        &ctx.accounts.token_program,
        holds,
    )
}

// ----- Ruling and expiry -----

/// Pays out the bond and closes the vault (rent to the disputer).
fn release_bond<'info>(
    record: &Account<'info, MarketDispute>,
    bond_vault: &Account<'info, TokenAccount>,
    recipient: &Account<'info, TokenAccount>,
    disputer: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
) -> Result<()> {
    let market = record.market;
    let bump = [record.bump];
    let seeds: &[&[u8]] = &[MARKET_DISPUTE_SEED, market.as_ref(), &bump];
    let amount = bond_vault.amount;
    if amount > 0 {
        transfer(
            CpiContext::new_with_signer(
                token_program.key(),
                Transfer {
                    from: bond_vault.to_account_info(),
                    to: recipient.to_account_info(),
                    authority: record.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
    }
    close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: bond_vault.to_account_info(),
            destination: disputer.clone(),
            authority: record.to_account_info(),
        },
        &[seeds],
    ))
}

/// Checks the ruler is an eligible admin for this market.
fn check_ruler(
    ruler: Pubkey,
    creator: Pubkey,
    resolver: Pubkey,
    fallback: Option<&PredictionFallback>,
) -> Result<()> {
    require!(
        ruler != creator && ruler != resolver && fallback.is_none_or(|f| f.resolver != ruler),
        dispute::IneligibleDisputeRuler
    );
    Ok(())
}

/// The token account a bond goes to: the treasury's when upheld, otherwise
/// the disputer's.
fn check_recipient(
    recipient: &TokenAccount,
    record: &MarketDispute,
    config: &DisputeConfig,
    upheld: bool,
) -> Result<()> {
    let owner = if upheld {
        config.treasury
    } else {
        record.disputer
    };
    require!(
        recipient.owner == owner && recipient.mint == record.bond_mint,
        dispute::InvalidBondRecipient
    );
    Ok(())
}

#[derive(Accounts)]
pub struct RulePredictionDispute<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [ADMIN_SEED, admin.key().as_ref()], bump = admin_record.bump,
        constraint = admin_record.authority == admin.key() @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Box<Account<'info, AdminRecord>>,
    #[account(mut)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut, seeds = [MARKET_DISPUTE_SEED, market.key().as_ref()], bump = dispute.bump)]
    pub dispute: Box<Account<'info, MarketDispute>>,
    #[account(seeds = [DISPUTE_CONFIG_SEED], bump = dispute_config.bump)]
    pub dispute_config: Box<Account<'info, DisputeConfig>>,
    /// CHECK: The market's club binding PDA; empty for a public market.
    #[account(seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump)]
    pub club_market: UncheckedAccount<'info>,
    /// CHECK: The admin's membership PDA in the market's club (verified in the
    /// handler); empty or a plain member, never a club admin.
    pub admin_club_member: UncheckedAccount<'info>,
    #[account(mut, seeds = [DISPUTE_BOND_SEED, market.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub recipient: Box<Account<'info, TokenAccount>>,
    /// CHECK: The disputer; receives the bond vault's rent.
    #[account(mut, address = dispute.disputer @ dispute::InvalidBondRecipient)]
    pub disputer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Rules on a binary market's open dispute. The ruling is final.
///
/// # Inputs
/// An eligible active admin, the market, its dispute record, the settings, the
/// club binding and the admin's club membership (for club markets), the bond
/// vault, the bond recipient (treasury when upheld, disputer otherwise) and the
/// disputer, plus the ruling.
/// # Errors
/// No open dispute; the deadline has passed; the admin is the creator, a
/// resolver or a club admin; an overturn to the same outcome or to Invalid; or
/// a wrong recipient.
/// # Returns
/// `Ok(())` with the market resolved, the bond paid out and, for an overturned
/// or invalid club market, the club penalty marked due.
pub fn handle_rule_prediction_dispute(
    ctx: Context<RulePredictionDispute>,
    ruling: PredictionRuling,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let record = &accounts.dispute;
    require!(record.state == DisputeState::Open, dispute::NoOpenDispute);
    require!(now < record.ruling_deadline, dispute::DisputeRulingExpired);
    let market = &accounts.market;
    let admin = accounts.admin.key();
    check_ruler(
        admin,
        market.authority,
        market.resolver,
        market.fallback.as_ref(),
    )?;
    // Club admins may not rule on their own club's markets.
    let binding = accounts.club_market.to_account_info();
    if !binding.data_is_empty() {
        let binding = ClubMarket::try_deserialize(&mut &binding.try_borrow_data()?[..])?;
        let expected = Pubkey::find_program_address(
            &[CLUB_MEMBER_SEED, binding.club.as_ref(), admin.as_ref()],
            &crate::ID,
        )
        .0;
        let member = accounts.admin_club_member.to_account_info();
        require_keys_eq!(member.key(), expected, dispute::IneligibleDisputeRuler);
        if !member.data_is_empty() {
            let member = ClubMember::try_deserialize(&mut &member.try_borrow_data()?[..])?;
            require!(
                member.role != ClubRole::Admin,
                dispute::IneligibleDisputeRuler
            );
        }
    }
    let (proposed, _) = market.proposal().ok_or(dispute::NoOpenDispute)?;
    let (outcome, state) = match ruling {
        PredictionRuling::Uphold => (proposed, DisputeState::Upheld),
        PredictionRuling::Overturn(outcome) => {
            require!(
                outcome != proposed && outcome != PredictionResolution::Invalid,
                dispute::InvalidDisputeRuling
            );
            (outcome, DisputeState::Overturned)
        }
        PredictionRuling::Invalid => (PredictionResolution::Invalid, DisputeState::Invalidated),
    };
    check_recipient(
        &accounts.recipient,
        record,
        &accounts.dispute_config,
        state == DisputeState::Upheld,
    )?;
    release_bond(
        &accounts.dispute,
        &accounts.bond_vault,
        &accounts.recipient,
        &accounts.disputer.to_account_info(),
        &accounts.token_program,
    )?;
    let accounts = ctx.accounts;
    let market = &mut accounts.market;
    market.set_final_outcome(outcome);
    market.set_status(PredictionStatus::Resolved);
    let record = &mut accounts.dispute;
    record.club_penalty_due = record.club_market && state != DisputeState::Upheld;
    record.state = state;
    record.ruled_by = Some(admin);
    Ok(())
}

#[derive(Accounts)]
pub struct RuleMultiOutcomeDispute<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [ADMIN_SEED, admin.key().as_ref()], bump = admin_record.bump,
        constraint = admin_record.authority == admin.key() @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Box<Account<'info, AdminRecord>>,
    #[account(mut, seeds = [MULTI_OUTCOME_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(mut, seeds = [MARKET_DISPUTE_SEED, market.key().as_ref()], bump = dispute.bump)]
    pub dispute: Box<Account<'info, MarketDispute>>,
    #[account(seeds = [DISPUTE_CONFIG_SEED], bump = dispute_config.bump)]
    pub dispute_config: Box<Account<'info, DisputeConfig>>,
    #[account(mut, seeds = [DISPUTE_BOND_SEED, market.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub recipient: Box<Account<'info, TokenAccount>>,
    /// CHECK: The disputer; receives the bond vault's rent.
    #[account(mut, address = dispute.disputer @ dispute::InvalidBondRecipient)]
    pub disputer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Rules on a multi-outcome market's open dispute. The ruling is final.
/// Same rules as binary; an overturn names a valid outcome other than the
/// proposed winner.
pub fn handle_rule_multi_outcome_dispute(
    ctx: Context<RuleMultiOutcomeDispute>,
    ruling: MultiOutcomeRuling,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let record = &accounts.dispute;
    require!(record.state == DisputeState::Open, dispute::NoOpenDispute);
    require!(now < record.ruling_deadline, dispute::DisputeRulingExpired);
    let market = &accounts.market;
    let admin = accounts.admin.key();
    check_ruler(
        admin,
        market.authority,
        market.terms.resolver,
        market.terms.fallback.as_ref(),
    )?;
    let (proposed, _) = market.proposal().ok_or(dispute::NoOpenDispute)?;
    let (outcome, state) = match ruling {
        MultiOutcomeRuling::Uphold => (proposed, DisputeState::Upheld),
        MultiOutcomeRuling::Overturn(id) => {
            let count = crate::multi_outcome::MultiOutcomeEconomics::from_terms(&market.terms)?
                .outcome_count;
            let outcome = MultiOutcomeResolution::Winner(id);
            require!(
                outcome.is_valid_for(count),
                multi_errors::InvalidMultiOutcomeId
            );
            require!(outcome != proposed, dispute::InvalidDisputeRuling);
            (outcome, DisputeState::Overturned)
        }
        MultiOutcomeRuling::Invalid => (MultiOutcomeResolution::Invalid, DisputeState::Invalidated),
    };
    check_recipient(
        &accounts.recipient,
        record,
        &accounts.dispute_config,
        state == DisputeState::Upheld,
    )?;
    release_bond(
        &accounts.dispute,
        &accounts.bond_vault,
        &accounts.recipient,
        &accounts.disputer.to_account_info(),
        &accounts.token_program,
    )?;
    let key = ctx.accounts.market.key();
    let accounts = ctx.accounts;
    let market = &mut accounts.market;
    market.set_final_outcome(outcome);
    market.set_status(PredictionStatus::Resolved);
    let record = &mut accounts.dispute;
    record.state = state;
    record.ruled_by = Some(admin);
    emit!(crate::MultiOutcomeResolutionEvent {
        market: key,
        outcome: Some(outcome),
        status: PredictionStatus::Resolved,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ExpirePredictionDispute<'info> {
    #[account(mut)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut, seeds = [MARKET_DISPUTE_SEED, market.key().as_ref()], bump = dispute.bump)]
    pub dispute: Box<Account<'info, MarketDispute>>,
    #[account(mut, seeds = [DISPUTE_BOND_SEED, market.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    /// The disputer's token account for the bond mint (checked in the handler).
    #[account(mut)]
    pub recipient: Box<Account<'info, TokenAccount>>,
    /// CHECK: The disputer; receives the bond vault's rent.
    #[account(mut, address = dispute.disputer @ dispute::InvalidBondRecipient)]
    pub disputer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Makes a binary market invalid when nobody ruled on its dispute in time.
/// Anyone may call it; the bond returns to the disputer and no club penalty
/// applies, because nobody found the club wrong.
pub fn handle_expire_prediction_dispute(ctx: Context<ExpirePredictionDispute>) -> Result<()> {
    expire_checks(&ctx.accounts.dispute, &ctx.accounts.recipient)?;
    release_bond(
        &ctx.accounts.dispute,
        &ctx.accounts.bond_vault,
        &ctx.accounts.recipient,
        &ctx.accounts.disputer.to_account_info(),
        &ctx.accounts.token_program,
    )?;
    let market = &mut ctx.accounts.market;
    market.set_final_outcome(PredictionResolution::Invalid);
    market.set_status(PredictionStatus::Resolved);
    ctx.accounts.dispute.state = DisputeState::Expired;
    Ok(())
}

#[derive(Accounts)]
pub struct ExpireMultiOutcomeDispute<'info> {
    #[account(mut, seeds = [MULTI_OUTCOME_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(mut, seeds = [MARKET_DISPUTE_SEED, market.key().as_ref()], bump = dispute.bump)]
    pub dispute: Box<Account<'info, MarketDispute>>,
    #[account(mut, seeds = [DISPUTE_BOND_SEED, market.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, TokenAccount>>,
    /// The disputer's token account for the bond mint (checked in the handler).
    #[account(mut)]
    pub recipient: Box<Account<'info, TokenAccount>>,
    /// CHECK: The disputer; receives the bond vault's rent.
    #[account(mut, address = dispute.disputer @ dispute::InvalidBondRecipient)]
    pub disputer: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

/// Makes a multi-outcome market invalid when nobody ruled in time.
pub fn handle_expire_multi_outcome_dispute(ctx: Context<ExpireMultiOutcomeDispute>) -> Result<()> {
    expire_checks(&ctx.accounts.dispute, &ctx.accounts.recipient)?;
    release_bond(
        &ctx.accounts.dispute,
        &ctx.accounts.bond_vault,
        &ctx.accounts.recipient,
        &ctx.accounts.disputer.to_account_info(),
        &ctx.accounts.token_program,
    )?;
    let key = ctx.accounts.market.key();
    let market = &mut ctx.accounts.market;
    market.set_final_outcome(MultiOutcomeResolution::Invalid);
    market.set_status(PredictionStatus::Resolved);
    ctx.accounts.dispute.state = DisputeState::Expired;
    emit!(crate::MultiOutcomeResolutionEvent {
        market: key,
        outcome: Some(MultiOutcomeResolution::Invalid),
        status: PredictionStatus::Resolved,
    });
    Ok(())
}

fn expire_checks(record: &MarketDispute, recipient: &TokenAccount) -> Result<()> {
    require!(record.state == DisputeState::Open, dispute::NoOpenDispute);
    require!(
        Clock::get()?.unix_timestamp >= record.ruling_deadline,
        dispute::DisputeRulingNotExpired
    );
    require!(
        recipient.mint == record.bond_mint && recipient.owner == record.disputer,
        dispute::InvalidBondRecipient
    );
    Ok(())
}
