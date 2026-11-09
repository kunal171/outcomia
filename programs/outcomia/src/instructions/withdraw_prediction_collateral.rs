//! Returns free collateral to the signing wallet using the market vault PDA.
//!
//! No lifecycle gate: closing trading or resolving a market must not trap cash.
//! Locked cash and payout reserves are separate claims and cannot be withdrawn.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::{
        PREDICTION_MARKET_SEED, PREDICTION_POSITION_SEED, VAULT_AUTHORITY_SEED, VAULT_SEED,
    },
    errors::{balance, prediction},
    state::{PredictionMarket, PredictionPosition},
};

#[derive(Accounts)]
pub struct WithdrawPredictionCollateral<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut,
        seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = market @ prediction::PredictionPositionMarketMismatch,
        has_one = owner @ prediction::PredictionPositionOwnerMismatch)]
    pub position: Account<'info, PredictionPosition>,
    #[account(address = market.collateral_mint @ prediction::InvalidPredictionCollateralMint)]
    pub collateral_mint: Account<'info, Mint>,
    // Requiring the wallet as token owner prevents redirecting another user's
    // internal claim, even if the supplied destination accepts the same mint.
    #[account(mut,
        constraint = destination.owner == owner.key() @ balance::InvalidWithdrawalDestinationOwner,
        constraint = destination.mint == collateral_mint.key() @ prediction::InvalidPredictionCollateralMint)]
    pub destination: Account<'info, TokenAccount>,
    /// CHECK: Stateless authority; only these canonical seeds sign the CPI.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut,
        address = market.collateral_vault @ prediction::InvalidPredictionVault,
        seeds = [VAULT_SEED, market.key().as_ref(), collateral_mint.key().as_ref()], bump,
        token::mint = collateral_mint, token::authority = vault_authority)]
    pub collateral_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Returns only free prediction cash to its owner.
///
/// # Inputs
/// `ctx`: owner/position, collateral mint, owner destination and canonical vault; positive raw
/// `amount`.
///
/// # Errors
/// Zero amount, wrong destination/mint/PDA, insufficient free cash/vault funds or rejected CPI.
///
/// # Returns
/// `Ok(())` after token transfer and free-claim debit; no lifecycle gate blocks existing free-cash
/// recovery.
pub fn handle_withdraw_prediction_collateral(
    ctx: Context<WithdrawPredictionCollateral>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, balance::InvalidWithdrawalAmount);
    let next_free = ctx
        .accounts
        .position
        .collateral_free
        .checked_sub(amount)
        .ok_or(balance::InsufficientFreeBalance)?;
    require!(
        ctx.accounts.collateral_vault.amount >= amount,
        balance::InsufficientVaultFunds
    );

    let market_key = ctx.accounts.market.key();
    let bump = [ctx.bumps.vault_authority];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, market_key.as_ref(), &bump];
    // Credit is debited only after the checked SPL transfer succeeds. Solana
    // rolls back the transfer and ledger together if any later instruction fails.
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.collateral_vault.to_account_info(),
                mint: ctx.accounts.collateral_mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.collateral_mint.decimals,
    )?;
    ctx.accounts.position.collateral_free = next_free;
    Ok(())
}
