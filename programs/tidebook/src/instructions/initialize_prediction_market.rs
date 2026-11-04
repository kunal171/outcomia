//! Creates a draft prediction market and its single-collateral account graph.
//!
//! The active-admin constraint is authoritative; a UI badge grants no access.
//! Anchor's init constraints run before the handler, so a validation failure
//! rolls back every account creation and token CPI in the transaction.
//! Opening, deposits and outcome positions remain separate milestones.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{
    constants::{
        ADMIN_SEED, MARKET_FEES_SEED, MARKET_METADATA_SEED, PREDICTION_MARKET_SEED,
        VAULT_AUTHORITY_SEED, VAULT_SEED,
    },
    errors::{admin, prediction},
    prediction_config::{validate_prediction_market_config, PredictionMarketConfig},
    state::{
        AdminRecord, AdminStatus, MarketFees, MarketKind, MarketMetadata, PredictionMarket,
        PredictionResolutionPhase, PredictionStatus,
    },
};

#[derive(Accounts)]
#[instruction(market_id: [u8; 32])]
pub struct InitializePredictionMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
        has_one = authority @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled
    )]
    pub admin_record: Account<'info, AdminRecord>,
    #[account(init, payer = authority, space = 8 + PredictionMarket::INIT_SPACE,
        seeds = [PREDICTION_MARKET_SEED, market_id.as_ref()], bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    /// Account<Mint> validates legacy SPL ownership and initialized mint data.
    pub collateral_mint: Account<'info, Mint>,
    /// CHECK: Stateless authority constrained to this market's signing PDA.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(init, payer = authority,
        seeds = [VAULT_SEED, market.key().as_ref(), collateral_mint.key().as_ref()], bump,
        token::mint = collateral_mint, token::authority = vault_authority)]
    pub collateral_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = authority, space = 8 + MarketMetadata::INIT_SPACE,
        seeds = [MARKET_METADATA_SEED, market.key().as_ref()], bump)]
    pub market_metadata: Box<Account<'info, MarketMetadata>>,
    /// Reuse the fee record's layout: quote_mint denotes collateral here.
    /// Existing spot fee-withdrawal instructions require Account<Market> and
    /// cannot operate on PredictionMarket. Prediction fee operations come later.
    #[account(init, payer = authority, space = 8 + MarketFees::INIT_SPACE,
        seeds = [MARKET_FEES_SEED, market.key().as_ref()], bump)]
    pub market_fees: Box<Account<'info, MarketFees>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_prediction_market(
    ctx: Context<InitializePredictionMarket>,
    market_id: [u8; 32],
    config: PredictionMarketConfig,
    display_name: String,
    collateral_symbol: String,
) -> Result<()> {
    validate_prediction_market_config(&config, Clock::get()?.unix_timestamp)?;
    super::market_metadata::validate_labels("YES-NO", &collateral_symbol, &display_name)?;
    // A winning whole contract pays exactly one collateral token. Token
    // decimals cannot silently change that meaning; zero-decimal mints also
    // fail the even-payout rule needed for exact Invalid half payouts.
    let expected_payout = 10_u64
        .checked_pow(u32::from(ctx.accounts.collateral_mint.decimals))
        .ok_or(prediction::InvalidPredictionPayout)?;
    require!(
        config.payout_per_contract == expected_payout,
        prediction::InvalidPredictionPayout
    );

    let market_key = ctx.accounts.market.key();
    ctx.accounts.market.set_inner(PredictionMarket {
        market_id,
        authority: ctx.accounts.authority.key(),
        resolver: config.resolver,
        fallback: config.fallback,
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
    ctx.accounts.market_metadata.set_inner(MarketMetadata {
        market: market_key,
        base_symbol: "YES-NO".into(),
        quote_symbol: collateral_symbol,
        display_name,
        kind: MarketKind::Prediction,
        bump: ctx.bumps.market_metadata,
    });
    ctx.accounts.market_fees.set_inner(MarketFees {
        market: market_key,
        quote_mint: ctx.accounts.collateral_mint.key(),
        accrued_quote_fees: 0,
        bump: ctx.bumps.market_fees,
    });
    Ok(())
}
