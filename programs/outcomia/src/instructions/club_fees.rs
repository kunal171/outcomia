//! Protocol-wide club fee share, set by the super-admin.
//!
//! Club markets charge the normal taker fee; this share of it is credited to
//! the market's club instead of the protocol. Changing the share affects only
//! later fills and never touches fees already accrued.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::*,
    errors::{admin, balance, club},
    fees::MAX_CLUB_FEE_SHARE_BPS,
    state::*,
};

#[derive(Accounts)]
pub struct SetClubFeeShare<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump,
        has_one = super_admin @ admin::UnauthorizedSuperAdmin)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(init_if_needed, payer = super_admin, space = 8 + ClubFeeConfig::INIT_SPACE,
        seeds = [CLUB_FEE_CONFIG_SEED], bump)]
    pub club_fee_config: Account<'info, ClubFeeConfig>,
    pub system_program: Program<'info, System>,
}

/// Creates or updates the club share of club-market taker fees.
///
/// # Inputs
/// The super-admin (paying rent on first use) and the share in basis points of the taker fee.
/// # Errors
/// `ClubFeeShareTooHigh` above 5,000 bps, or a signer other than the stored super-admin.
/// # Returns
/// `Ok(())` with the share stored for subsequent club fills.
pub fn handle_set_club_fee_share(ctx: Context<SetClubFeeShare>, club_share_bps: u16) -> Result<()> {
    require!(
        club_share_bps <= MAX_CLUB_FEE_SHARE_BPS,
        club::ClubFeeShareTooHigh
    );
    ctx.accounts.club_fee_config.set_inner(ClubFeeConfig {
        club_share_bps,
        bump: ctx.bumps.club_fee_config,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawClubFees<'info> {
    pub owner: Signer<'info>,
    #[account(has_one = owner @ club::UnauthorizedClubOwner)]
    pub club: Box<Account<'info, Club>>,
    #[account(mut, seeds = [CLUB_MARKET_SEED, club_market.market.as_ref()], bump = club_market.bump,
        has_one = club @ club::InvalidClubMarket)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    #[account(address = club_market.market @ club::InvalidClubMarket,
        seeds = [CLUB_PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(address = market.collateral_mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub destination: Box<Account<'info, TokenAccount>>,
    /// CHECK: Mint-specific global vault authority.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = vault_authority)]
    pub asset_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawClubBookFees<'info> {
    pub super_admin: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump,
        has_one = super_admin @ admin::UnauthorizedAdmin)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [CLUB_BOOK_SEED, book.market.as_ref()], bump = book.bump)]
    pub book: Box<Account<'info, SharedBook>>,
    #[account(address = book.quote_mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = super_admin)]
    pub destination: Box<Account<'info, TokenAccount>>,
    /// CHECK: Mint-specific global vault authority.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = vault_authority)]
    pub asset_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Pays `amount` of an accrued fee claim out of the global vault.
#[allow(clippy::too_many_arguments)]
fn pay_out<'info>(
    accrued: &mut u64,
    amount: u64,
    mint: &Account<'info, Mint>,
    destination: AccountInfo<'info>,
    vault_authority: AccountInfo<'info>,
    vault_authority_bump: u8,
    asset_vault: AccountInfo<'info>,
    token_program: Pubkey,
) -> Result<()> {
    require!(amount > 0, balance::InvalidWithdrawalAmount);
    let remaining = accrued
        .checked_sub(amount)
        .ok_or(balance::InsufficientFreeBalance)?;
    let mint_key = mint.key();
    let bump = [vault_authority_bump];
    let seeds: &[&[u8]] = &[ASSET_AUTHORITY_SEED, mint_key.as_ref(), &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from: asset_vault,
                mint: mint.to_account_info(),
                to: destination,
                authority: vault_authority,
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )?;
    *accrued = remaining;
    Ok(())
}

/// Withdraws the club's accrued fee share from one club market.
///
/// # Inputs
/// The club owner, its club and club market, the market's mint, a destination token account the
/// owner controls, and the global vault; positive atoms.
/// # Errors
/// Signer is not the owner, foreign club market, zero or excess amount, or CPI failure.
/// # Returns
/// `Ok(())` with the club fee claim and physical custody reduced equally.
pub fn handle_withdraw_club_fees(ctx: Context<WithdrawClubFees>, amount: u64) -> Result<()> {
    let a = &mut *ctx.accounts;
    pay_out(
        &mut a.club_market.accrued_club_fees,
        amount,
        &a.mint,
        a.destination.to_account_info(),
        a.vault_authority.to_account_info(),
        ctx.bumps.vault_authority,
        a.asset_vault.to_account_info(),
        a.token_program.key(),
    )
}

/// Withdraws the protocol's share of fees from a club book (super-admin).
///
/// # Errors
/// Signer is not the super-admin, zero or excess amount, or CPI failure.
/// # Returns
/// `Ok(())` with the book fee claim and physical custody reduced equally.
pub fn handle_withdraw_club_book_fees(
    ctx: Context<WithdrawClubBookFees>,
    amount: u64,
) -> Result<()> {
    let a = &mut *ctx.accounts;
    pay_out(
        &mut a.book.accrued_quote_fees,
        amount,
        &a.mint,
        a.destination.to_account_info(),
        a.vault_authority.to_account_info(),
        ctx.bumps.vault_authority,
        a.asset_vault.to_account_info(),
        a.token_program.key(),
    )
}
