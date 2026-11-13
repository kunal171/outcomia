//! Canonical multi-outcome drafts, creator-controlled opening/closure and empty positions.
//! Initialization failures roll back rent allocations and vault creation. The
//! primary resolver is the active-admin creator; metadata cannot change that role.
use crate::{
    constants::*,
    errors::{admin, multi_outcome as multi, prediction},
    events::*,
    multi_outcome::validate_multi_outcome_terms,
    state::*,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
#[instruction(market_id: [u8; 32])]
pub struct InitializeMultiOutcomeMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump,
        has_one = authority @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Account<'info, AdminRecord>,
    #[account(init, payer = authority, space = 8 + MultiOutcomeMarket::INIT_SPACE,
        seeds = [MULTI_OUTCOME_MARKET_SEED, market_id.as_ref()], bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    pub collateral_mint: Account<'info, Mint>,
    /// CHECK: Stateless signing PDA, scoped to this exact new market.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(init, payer = authority, seeds = [VAULT_SEED, market.key().as_ref(), collateral_mint.key().as_ref()], bump,
        token::mint = collateral_mint, token::authority = vault_authority)]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = authority, space = 8 + MarketMetadata::INIT_SPACE,
        seeds = [MARKET_METADATA_SEED, market.key().as_ref()], bump)]
    pub market_metadata: Box<Account<'info, MarketMetadata>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Inputs: active creator, initialized SPL mint, new canonical accounts, ID,
/// immutable terms and presentation labels. Errors: role/PDA/duplicate, invalid
/// terms, non-creator resolver, labels or face payout different from one token.
/// Returns: Draft with zero supplies/backing, canonical reserve and metadata.
/// Opening enables complete sets; order books and matching arrive separately.
pub fn handle_initialize_multi_outcome_market(
    ctx: Context<InitializeMultiOutcomeMarket>,
    market_id: [u8; 32],
    terms: MultiOutcomeTerms,
    display_name: String,
    collateral_symbol: String,
) -> Result<()> {
    let economics = validate_multi_outcome_terms(&terms, Clock::get()?.unix_timestamp)?;
    require_keys_eq!(
        terms.resolver,
        ctx.accounts.authority.key(),
        prediction::PredictionCreatorMustResolve
    );
    super::market_metadata::validate_labels("OUTCOMES", &collateral_symbol, &display_name)?;
    // As with binary markets, a winning whole contract pays one actual mint
    // token. Lot sizing, not a rounded face value, makes Invalid refunds exact.
    let payout = 10_u64
        .checked_pow(u32::from(ctx.accounts.collateral_mint.decimals))
        .ok_or(multi::InvalidMultiOutcomePayout)?;
    require!(
        terms.payout_per_contract == payout,
        multi::InvalidMultiOutcomePayout
    );
    let market = ctx.accounts.market.key();
    ctx.accounts.market.set_inner(MultiOutcomeMarket {
        market_id,
        authority: ctx.accounts.authority.key(),
        collateral_mint: ctx.accounts.collateral_mint.key(),
        collateral_vault: ctx.accounts.collateral_vault.key(),
        metadata: ctx.accounts.market_metadata.key(),
        terms,
        resolution_phase: PredictionResolutionPhase::Primary,
        status: PredictionStatus::Draft,
        proposal: None,
        final_outcome: None,
        supplies: [0; MULTI_OUTCOME_CAPACITY],
        backing_reserve: 0,
        open_order_count: 0,
        bump: ctx.bumps.market,
    });
    ctx.accounts.market_metadata.set_inner(MarketMetadata {
        market,
        base_symbol: "OUTCOMES".into(),
        quote_symbol: collateral_symbol,
        display_name,
        kind: MarketKind::Prediction,
        bump: ctx.bumps.market_metadata,
    });
    emit!(MultiOutcomeMarketInitializedEvent {
        market,
        authority: ctx.accounts.authority.key(),
        collateral_mint: ctx.accounts.collateral_mint.key(),
        collateral_vault: ctx.accounts.collateral_vault.key(),
        outcome_count: economics.outcome_count,
        payout_per_contract: payout,
        quantity_lot: economics.quantity_lot
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ManageMultiOutcomeMarket<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [MULTI_OUTCOME_MARKET_SEED, market.market_id.as_ref()], bump = market.bump,
        has_one = authority @ prediction::UnauthorizedPredictionAuthority,
        constraint = market.terms.resolver == authority.key() @ prediction::PredictionCreatorMustResolve)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump,
        has_one = authority @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Account<'info, AdminRecord>,
}

/// Inputs: stored creator and their active admin record. Errors: role, expired
/// draft or non-Draft status. Returns: Open with the original terms/counters.
pub fn handle_open_multi_outcome_market(ctx: Context<ManageMultiOutcomeMarket>) -> Result<()> {
    require!(
        ctx.accounts.market.status == PredictionStatus::Draft,
        prediction::PredictionNotDraft
    );
    require!(
        Clock::get()?.unix_timestamp < ctx.accounts.market.terms.close_ts,
        prediction::PredictionOpeningClosed
    );
    ctx.accounts.market.status = PredictionStatus::Open;
    emit!(MultiOutcomeMarketStatusEvent {
        market: ctx.accounts.market.key(),
        authority: ctx.accounts.authority.key(),
        status: PredictionStatus::Open
    });
    Ok(())
}

/// Inputs: active-admin creator of an Open market. Errors: role or non-Open
/// state. Returns: Frozen, preserving deadlines, claims and owner merge rights.
pub fn handle_close_multi_outcome_trading(ctx: Context<ManageMultiOutcomeMarket>) -> Result<()> {
    require!(
        ctx.accounts.market.status == PredictionStatus::Open,
        prediction::PredictionOrderUnavailable
    );
    ctx.accounts.market.status = PredictionStatus::Frozen;
    emit!(MultiOutcomeMarketStatusEvent {
        market: ctx.accounts.market.key(),
        authority: ctx.accounts.authority.key(),
        status: PredictionStatus::Frozen
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeMultiOutcomePosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [MULTI_OUTCOME_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(init, payer = owner, space = 8 + MultiOutcomePosition::INIT_SPACE,
        seeds = [MULTI_OUTCOME_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Account<'info, MultiOutcomePosition>,
    pub system_program: Program<'info, System>,
}

/// Inputs: wallet signer/payer and canonical market/position. Errors: duplicate,
/// wrong PDA/account type or rent failure. Returns: an empty owned position; no
/// admin/lifecycle gate because no funds or outcome claims are created here.
pub fn handle_initialize_multi_outcome_position(
    ctx: Context<InitializeMultiOutcomePosition>,
) -> Result<()> {
    ctx.accounts.position.set_inner(MultiOutcomePosition {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        free: [0; MULTI_OUTCOME_CAPACITY],
        locked: [0; MULTI_OUTCOME_CAPACITY],
        bump: ctx.bumps.position,
    });
    emit!(MultiOutcomePositionInitializedEvent {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        position: ctx.accounts.position.key()
    });
    Ok(())
}
