//! Complete sets and redemption in club markets.
//!
//! Accounts match the public shared custody, with the club market seed and
//! the club binding. Splitting is an entry action, so members-only markets
//! require current membership for it; merging and redemption are exits and
//! never do. Transfers and accounting are the shared [`Custody`] logic.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::{club_markets::require_club_access, shared_prediction::Custody};
use crate::{
    constants::*,
    errors::{club, prediction, shared},
    state::*,
};

#[derive(Accounts)]
pub struct ClubPredictionCustody<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CLUB_PREDICTION_MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump = club_market.bump,
        has_one = market @ club::InvalidClubMarket)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    /// The owner's membership; needed only to split in a members-only market.
    pub member: Option<Box<Account<'info, ClubMember>>>,
    #[account(mut, seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner @ prediction::PredictionPositionOwnerMismatch,
        has_one = market @ prediction::PredictionPositionMarketMismatch)]
    pub position: Box<Account<'info, PredictionPosition>>,
    #[account(address = market.collateral_mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [ASSET_BALANCE_SEED, owner.key().as_ref(), mint.key().as_ref()],
        bump = asset_balance.bump,
        has_one = owner @ shared::InvalidAssetBalance, has_one = mint @ shared::InvalidAssetBalance)]
    pub asset_balance: Box<Account<'info, AssetBalance>>,
    /// CHECK: Canonical mint-specific global authority.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub asset_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = asset_authority)]
    pub asset_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: Canonical question-specific reserve authority.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub market_authority: UncheckedAccount<'info>,
    #[account(mut, address = market.collateral_vault,
        seeds = [VAULT_SEED, market.key().as_ref(), mint.key().as_ref()], bump,
        token::mint = mint, token::authority = market_authority)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

impl<'info> ClubPredictionCustody<'info> {
    fn custody<'a>(&'a mut self, bumps: &ClubPredictionCustodyBumps) -> Custody<'a, 'info> {
        Custody {
            market_key: self.market.key(),
            market: &mut self.market,
            position: &mut self.position,
            balance: &mut self.asset_balance,
            mint: self.mint.to_account_info(),
            decimals: self.mint.decimals,
            asset_authority: self.asset_authority.to_account_info(),
            asset_authority_bump: bumps.asset_authority,
            asset_vault: self.asset_vault.to_account_info(),
            market_authority: self.market_authority.to_account_info(),
            market_authority_bump: bumps.market_authority,
            market_vault: self.market_vault.to_account_info(),
            token_program: self.token_program.key(),
        }
    }
}

/// Splits shared cash into YES/NO pairs, or merges pairs back into cash.
///
/// # Inputs
/// Owner custody accounts, the club binding, the owner's membership when splitting in a
/// members-only market, a positive quantity and the split flag.
/// # Errors
/// Splitting without current membership in a members-only market, plus every shared custody
/// error (lifecycle, balances, overflow, CPI).
/// # Returns
/// The same transfers and accounting as public shared complete sets.
pub fn handle_club_complete_set(
    ctx: Context<ClubPredictionCustody>,
    quantity: u64,
    split: bool,
) -> Result<()> {
    if split {
        require_club_access(
            &ctx.accounts.club_market,
            ctx.accounts.member.as_deref().map(|m| &**m),
            ctx.accounts.owner.key(),
        )?;
    }
    ctx.accounts
        .custody(&ctx.bumps)
        .complete_set(quantity, split)
}

/// Redeems resolved contracts; membership is never required.
///
/// # Errors
/// Every shared redemption error (not resolved, nothing to redeem, balances, CPI).
/// # Returns
/// The same payout as public shared redemption.
pub fn handle_redeem_club_prediction(
    ctx: Context<ClubPredictionCustody>,
    yes: u64,
    no: u64,
) -> Result<()> {
    ctx.accounts.custody(&ctx.bumps).redeem(yes, no)
}
