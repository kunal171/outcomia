//! Moves a trader's collateral tokens into the canonical prediction vault.
//!
//! The SPL transfer and free-collateral credit are atomic. Depositing does not
//! split collateral, issue positions, lock orders or increase payout reserves.
//! All non-resolved statuses allow cash funding; trading has separate gates.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{
    constants::{
        PREDICTION_MARKET_SEED, PREDICTION_POSITION_SEED, VAULT_AUTHORITY_SEED, VAULT_SEED,
    },
    errors::{balance, prediction},
    state::{PredictionMarket, PredictionPosition, PredictionStatus},
};

#[derive(Accounts)]
pub struct DepositPredictionCollateral<'info> {
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
    /// Explicit wallet ownership excludes funding from another user's account
    /// through a delegated transfer allowance; only the source owner signs.
    #[account(mut,
        constraint = source.owner == owner.key() @ prediction::InvalidPredictionTokenOwner,
        constraint = source.mint == collateral_mint.key() @ prediction::InvalidPredictionCollateralMint)]
    pub source: Account<'info, TokenAccount>,

    /// CHECK: Stateless, seed-constrained authority of this market's vault.
    /// It does not sign this CPI: the wallet owns and signs for the source.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut,
        address = market.collateral_vault @ prediction::InvalidPredictionVault,
        seeds = [VAULT_SEED, market.key().as_ref(), collateral_mint.key().as_ref()], bump,
        token::mint = collateral_mint, token::authority = vault_authority)]
    pub collateral_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Credits free prediction cash from a checked token transfer.
///
/// # Inputs
/// `ctx`: owner/position, collateral mint, owner source and canonical vault; positive raw `amount`.
///
/// # Errors
/// Resolved market, zero amount, wrong source/mint/PDA, insufficient tokens, credit overflow or
/// failed CPI.
///
/// # Returns
/// `Ok(())` after custody/free cash increase equally; supply and payout reserve do not change.
pub fn handle_deposit_prediction_collateral(
    ctx: Context<DepositPredictionCollateral>,
    amount: u64,
) -> Result<()> {
    require!(
        ctx.accounts.market.status != PredictionStatus::Resolved,
        prediction::PredictionDepositAfterResolution
    );
    require!(amount > 0, balance::InvalidDepositAmount);
    require!(
        ctx.accounts.source.amount >= amount,
        balance::InsufficientDepositFunds
    );

    // Detect overflow before the CPI. Write the new claim only after SPL Token
    // accepts the transfer; any CPI/account serialization failure rolls back
    // the entire transaction, including earlier instructions in a batch.
    let next_free = ctx
        .accounts
        .position
        .collateral_free
        .checked_add(amount)
        .ok_or(balance::FreeBalanceOverflow)?;
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.collateral_mint.to_account_info(),
                to: ctx.accounts.collateral_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.collateral_mint.decimals,
    )?;
    ctx.accounts.position.collateral_free = next_free;
    Ok(())
}
