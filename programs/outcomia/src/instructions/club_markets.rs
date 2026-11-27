//! Binary markets in the club namespace: creation, opening and closing.
//!
//! Club markets live at ["club_prediction_market", market_id]. Public
//! instructions only derive the public seed, so they can never reach a club
//! market; club instructions perform the club checks and reuse the shared
//! custody and resolution logic.
//!
//! Club markets have no fallback resolver: any current club admin resolves.
//! They trade only on club books, so no legacy per-market book or fee record
//! is created.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{
    constants::{
        CLUB_MARKET_SEED, CLUB_MEMBER_SEED, CLUB_PREDICTION_MARKET_SEED, CLUB_RULES_CONFIG_SEED,
        MARKET_METADATA_SEED, PREDICTION_POSITION_SEED, VAULT_AUTHORITY_SEED, VAULT_SEED,
    },
    errors::{club, prediction},
    prediction_config::{validate_prediction_market_config, PredictionMarketConfig},
    state::*,
};

#[derive(Accounts)]
#[instruction(market_id: [u8; 32])]
pub struct CreateClubPredictionMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut)]
    pub club: Box<Account<'info, Club>>,
    #[account(seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), creator.key().as_ref()],
        bump = creator_member.bump)]
    pub creator_member: Box<Account<'info, ClubMember>>,
    #[account(init, payer = creator, space = 8 + PredictionMarket::INIT_SPACE,
        seeds = [CLUB_PREDICTION_MARKET_SEED, market_id.as_ref()], bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(init, payer = creator, space = 8 + ClubMarket::INIT_SPACE,
        seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    pub collateral_mint: Box<Account<'info, Mint>>,
    /// CHECK: Stateless authority constrained to this market's signing PDA.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(init, payer = creator,
        seeds = [VAULT_SEED, market.key().as_ref(), collateral_mint.key().as_ref()], bump,
        token::mint = collateral_mint, token::authority = vault_authority)]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = creator, space = 8 + MarketMetadata::INIT_SPACE,
        seeds = [MARKET_METADATA_SEED, market.key().as_ref()], bump)]
    pub market_metadata: Box<Account<'info, MarketMetadata>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    #[account(seeds = [CLUB_RULES_CONFIG_SEED], bump = club_rules.bump)]
    pub club_rules: Box<Account<'info, ClubRulesConfig>>,
    /// Fresh Pyth SOL/USD price; required only when the club's deposit is SOL.
    pub price_update: Option<Box<Account<'info, PriceUpdateV2>>>,
}

/// Opening a draft club market: the management checks plus the club's deposit.
#[derive(Accounts)]
pub struct OpenClubPredictionMarket<'info> {
    pub actor: Signer<'info>,
    #[account(seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump = club_market.bump,
        has_one = market @ club::InvalidClubMarket, has_one = club @ club::InvalidClubMarket)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    #[account(mut, seeds = [CLUB_PREDICTION_MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(seeds = [CLUB_MEMBER_SEED, club_market.club.as_ref(), actor.key().as_ref()],
        bump = actor_member.bump,
        constraint = actor_member.role == ClubRole::Admin
            || actor_member.wallet == club_market.creator @ club::UnauthorizedClubAdmin)]
    pub actor_member: Box<Account<'info, ClubMember>>,
    pub club: Box<Account<'info, Club>>,
    #[account(seeds = [CLUB_RULES_CONFIG_SEED], bump = club_rules.bump)]
    pub club_rules: Box<Account<'info, ClubRulesConfig>>,
    /// Fresh Pyth SOL/USD price; required only when the club's deposit is SOL.
    pub price_update: Option<Box<Account<'info, PriceUpdateV2>>>,
}

/// A club admin, or the market's creator while still a member, managing a club market.
#[derive(Accounts)]
pub struct ManageClubPredictionMarket<'info> {
    pub actor: Signer<'info>,
    #[account(seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump = club_market.bump,
        has_one = market @ club::InvalidClubMarket)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    #[account(mut, seeds = [CLUB_PREDICTION_MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(seeds = [CLUB_MEMBER_SEED, club_market.club.as_ref(), actor.key().as_ref()],
        bump = actor_member.bump,
        constraint = actor_member.role == ClubRole::Admin
            || actor_member.wallet == club_market.creator @ club::UnauthorizedClubAdmin)]
    pub actor_member: Box<Account<'info, ClubMember>>,
}

#[derive(Accounts)]
pub struct InitializeClubPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CLUB_PREDICTION_MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(init, payer = owner, space = 8 + PredictionPosition::INIT_SPACE,
        seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Box<Account<'info, PredictionPosition>>,
    pub system_program: Program<'info, System>,
}

/// Admits `wallet` to an entry action (split, placement, fill) in a club market.
///
/// Public markets admit everyone. Members-only markets require the wallet's
/// current `ClubMember` record for the market's club. A record exists only
/// while the wallet is a member, so removal takes effect immediately.
///
/// # Errors
/// `ClubMembershipRequired` when the market is members-only and the record is
/// missing or belongs to another club or wallet.
pub(crate) fn require_club_access(
    club_market: &ClubMarket,
    member: Option<&ClubMember>,
    wallet: Pubkey,
) -> Result<()> {
    if club_market.access == ClubMarketAccess::Public {
        return Ok(());
    }
    require!(
        member.is_some_and(|m| m.club == club_market.club && m.wallet == wallet),
        club::ClubMembershipRequired
    );
    Ok(())
}

/// Creates a draft binary market owned by a club.
///
/// # Inputs
/// A member allowed by the club's market policy, the collateral mint, new market accounts, the
/// 32-byte id, rules config (resolver = creator, no fallback), labels and access mode, plus the
/// club rules and, for a SOL deposit, a fresh SOL/USD price.
/// # Errors
/// Policy forbids the creator, a fallback or foreign resolver, invalid terms, labels or payout,
/// an id already in use, or the club's deposit below its minimum.
/// # Returns
/// A Draft market with empty supplies and its `ClubMarket` binding; the club counts it as live.
pub fn handle_create_club_prediction_market(
    ctx: Context<CreateClubPredictionMarket>,
    market_id: [u8; 32],
    config: PredictionMarketConfig,
    display_name: String,
    collateral_symbol: String,
    access: ClubMarketAccess,
) -> Result<()> {
    require!(
        ctx.accounts.creator_member.role == ClubRole::Admin
            || ctx.accounts.club.market_policy == ClubMarketPolicy::AnyMember,
        club::UnauthorizedClubAdmin
    );
    validate_prediction_market_config(&config, Clock::get()?.unix_timestamp)?;
    // Club admins resolve; the stored resolver records the creator only.
    require!(
        config.fallback.is_none() && config.resolver == ctx.accounts.creator.key(),
        club::InvalidClubMarket
    );
    super::market_metadata::validate_labels("YES-NO", &collateral_symbol, &display_name)?;
    super::initialize_prediction_market::validate_binary_payout(
        &config,
        ctx.accounts.collateral_mint.decimals,
    )?;
    super::club_deposits::require_club_funded(
        &ctx.accounts.club,
        &ctx.accounts.club_rules,
        ctx.accounts.price_update.as_deref().map(|a| &**a),
    )?;
    let club = &mut ctx.accounts.club;
    club.live_markets = club
        .live_markets
        .checked_add(1)
        .ok_or(club::ClubCounterMismatch)?;

    let market_key = ctx.accounts.market.key();
    let creator = ctx.accounts.creator.key();
    ctx.accounts.market.set_inner(PredictionMarket {
        market_id,
        authority: creator,
        resolver: creator,
        fallback: None,
        collateral_mint: ctx.accounts.collateral_mint.key(),
        collateral_vault: ctx.accounts.collateral_vault.key(),
        metadata: ctx.accounts.market_metadata.key(),
        question_hash: config.question_hash,
        rules_hash: config.rules_hash,
        rules_uri: config.rules_uri,
        close_ts: config.close_ts,
        earliest_resolution_ts: config.earliest_resolution_ts,
        resolution_delay_seconds: config.resolution_delay_seconds,
        resolution_phase: PredictionResolutionPhase::Primary,
        status: PredictionStatus::Draft,
        proposal: None,
        final_outcome: None,
        payout_per_contract: config.payout_per_contract,
        price_tick: config.price_tick,
        yes_supply: 0,
        no_supply: 0,
        backing_reserve: 0,
        open_order_count: 0,
        bump: ctx.bumps.market,
    });
    ctx.accounts.club_market.set_inner(ClubMarket {
        club: ctx.accounts.club.key(),
        market: market_key,
        access,
        creator,
        accrued_club_fees: 0,
        bump: ctx.bumps.club_market,
    });
    ctx.accounts.market_metadata.set_inner(MarketMetadata {
        market: market_key,
        base_symbol: "YES-NO".into(),
        quote_symbol: collateral_symbol,
        display_name,
        kind: MarketKind::Prediction,
        bump: ctx.bumps.market_metadata,
    });
    Ok(())
}

/// Opens an unexpired draft club market.
///
/// # Errors
/// Signer is neither a club admin nor the creator-member, the market is not a Draft, it is
/// already past its close time, or the club's deposit is below its minimum.
/// # Returns
/// `Ok(())` with status Open; terms are unchanged.
pub fn handle_open_club_prediction_market(ctx: Context<OpenClubPredictionMarket>) -> Result<()> {
    super::club_deposits::require_club_funded(
        &ctx.accounts.club,
        &ctx.accounts.club_rules,
        ctx.accounts.price_update.as_deref().map(|a| &**a),
    )?;
    let market = &mut ctx.accounts.market;
    require!(
        market.status == PredictionStatus::Draft,
        prediction::PredictionNotDraft
    );
    require!(
        Clock::get()?.unix_timestamp < market.close_ts,
        prediction::PredictionOpeningClosed
    );
    market.status = PredictionStatus::Open;
    Ok(())
}

/// Stops trading early; the published resolution schedule is unchanged.
///
/// # Errors
/// Signer is neither a club admin nor the creator-member, or the market is not Open.
/// # Returns
/// `Ok(())` with status Frozen; merges and withdrawals stay available.
pub fn handle_close_club_trading(ctx: Context<ManageClubPredictionMarket>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(
        market.status == PredictionStatus::Open,
        crate::errors::shared::PredictionResolutionUnavailable
    );
    market.status = PredictionStatus::Frozen;
    Ok(())
}

/// Creates an empty position in a club market. Anyone may hold one, so former
/// members and public-market traders can always exit.
///
/// # Returns
/// `Ok(())` with every balance zero.
pub fn handle_initialize_club_position(ctx: Context<InitializeClubPosition>) -> Result<()> {
    ctx.accounts.position.set_inner(PredictionPosition {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        collateral_free: 0,
        collateral_locked: 0,
        yes_free: 0,
        yes_locked: 0,
        no_free: 0,
        no_locked: 0,
        bump: ctx.bumps.position,
    });
    Ok(())
}
