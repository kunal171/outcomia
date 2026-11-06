//! Custody for a wallet/mint pair, shared by every market's new execution book.
//!
//! A ledger is created once. No deposit or withdrawal changes a locked claim.
//! All CPI amounts are mint atoms, not human-readable token quantities.
use crate::{
    constants::*,
    errors::{balance, shared},
    state::*,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
pub struct InitializeAssetBalance<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = owner, space = 8 + AssetBalance::INIT_SPACE,
        seeds = [ASSET_BALANCE_SEED, owner.key().as_ref(), mint.key().as_ref()], bump)]
    pub asset_balance: Account<'info, AssetBalance>,
    /// CHECK: Stateless, mint-specific authority; its seeds sign withdrawals.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = owner,
        seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = vault_authority)]
    pub asset_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Creates a zeroed shared ledger; a duplicate init cannot erase existing claims.
///
/// # Inputs
/// Owner/payer signer, SPL mint, new ledger and canonical shared vault.
/// # Errors
/// Duplicate ledger, incorrect mint/vault/authority, rent or account allocation failure.
/// # Returns
/// `Ok(())` with zero free/locked funds; no tokens are deposited.
pub fn handle_initialize_asset_balance(ctx: Context<InitializeAssetBalance>) -> Result<()> {
    ctx.accounts.asset_balance.set_inner(AssetBalance {
        owner: ctx.accounts.owner.key(),
        mint: ctx.accounts.mint.key(),
        free: 0,
        locked: 0,
        bump: ctx.bumps.asset_balance,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct TransferAsset<'info> {
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [ASSET_BALANCE_SEED, owner.key().as_ref(), mint.key().as_ref()], bump = asset_balance.bump,
        has_one = owner @ shared::InvalidAssetBalance, has_one = mint @ shared::InvalidAssetBalance)]
    pub asset_balance: Account<'info, AssetBalance>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub wallet_token: Account<'info, TokenAccount>,
    /// CHECK: Canonical authority; only this program can sign its seeds.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = vault_authority)]
    pub asset_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Deposits real SPL tokens and credits only the matching global free balance.
///
/// # Inputs
/// Owner, matching mint/ledger, owned source and canonical vault; positive `amount` atoms.
/// # Errors
/// Zero amount, insufficient tokens, wrong owner/mint/vault, overflow or failed transfer.
/// # Returns
/// `Ok(())` with vault and free claim increased equally. All markets can use this free claim.
pub fn handle_deposit_asset(ctx: Context<TransferAsset>, amount: u64) -> Result<()> {
    require!(amount > 0, balance::InvalidDepositAmount);
    require!(
        ctx.accounts.wallet_token.amount >= amount,
        balance::InsufficientDepositFunds
    );
    let free = ctx
        .accounts
        .asset_balance
        .free
        .checked_add(amount)
        .ok_or(balance::FreeBalanceOverflow)?;
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.wallet_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    ctx.accounts.asset_balance.free = free;
    Ok(())
}

/// Withdraws free cash to the same owner's SPL account; locked funds are never spendable.
///
/// # Inputs
/// Owner signer, canonical ledger/vault, owned destination and positive mint-atom amount.
/// # Errors
/// Zero amount, insufficient free/vault balance, wrong owner/mint or rejected SPL CPI.
/// # Returns
/// `Ok(())` with custody and free claim reduced equally; locked balance is unchanged.
pub fn handle_withdraw_asset(ctx: Context<TransferAsset>, amount: u64) -> Result<()> {
    require!(amount > 0, balance::InvalidWithdrawalAmount);
    let free = ctx
        .accounts
        .asset_balance
        .free
        .checked_sub(amount)
        .ok_or(balance::InsufficientFreeBalance)?;
    require!(
        ctx.accounts.asset_vault.amount >= amount,
        balance::InsufficientVaultFunds
    );
    let mint = ctx.accounts.mint.key();
    let bump = [ctx.bumps.vault_authority];
    let seeds: &[&[u8]] = &[ASSET_AUTHORITY_SEED, mint.as_ref(), &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.wallet_token.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    ctx.accounts.asset_balance.free = free;
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateSpotAsset<'info> {
    pub owner: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [TRADER_BALANCE_SEED, market.key().as_ref(), owner.key().as_ref()], bump = trader_balance.bump,
        has_one = owner @ balance::TraderBalanceOwnerMismatch, has_one = market @ balance::TraderBalanceMarketMismatch)]
    pub trader_balance: Account<'info, TraderBalance>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [ASSET_BALANCE_SEED, owner.key().as_ref(), mint.key().as_ref()], bump = asset_balance.bump,
        has_one = owner @ shared::InvalidAssetBalance, has_one = mint @ shared::InvalidAssetBalance)]
    pub asset_balance: Account<'info, AssetBalance>,
    /// CHECK: Legacy market signing authority, never an arbitrary token owner.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub market_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [VAULT_SEED, market.key().as_ref(), mint.key().as_ref()], bump,
        token::mint = mint, token::authority = market_authority)]
    pub market_vault: Account<'info, TokenAccount>,
    /// CHECK: Global destination authority; it does not sign this inward transfer.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub asset_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = asset_authority)]
    pub asset_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Moves existing free spot claims into global custody without touching open-order locks.
///
/// # Inputs
/// Owner, legacy market/ledger/vault, matching global ledger/vault, mint and positive atoms.
/// # Errors
/// Wrong owner/mint/PDA, insufficient free cash, credit overflow or CPI failure.
/// # Returns
/// `Ok(())` with legacy free/vault debited and global free/vault credited equally, atomically.
pub fn handle_migrate_spot_asset(ctx: Context<MigrateSpotAsset>, amount: u64) -> Result<()> {
    require!(amount > 0, balance::InvalidDepositAmount);
    let mint = ctx.accounts.mint.key();
    let free = if mint == ctx.accounts.market.base_mint {
        &mut ctx.accounts.trader_balance.base_free
    } else if mint == ctx.accounts.market.quote_mint {
        &mut ctx.accounts.trader_balance.quote_free
    } else {
        return err!(balance::InvalidDepositMint);
    };
    let remaining = free
        .checked_sub(amount)
        .ok_or(balance::InsufficientFreeBalance)?;
    let shared_free = ctx
        .accounts
        .asset_balance
        .free
        .checked_add(amount)
        .ok_or(balance::FreeBalanceOverflow)?;
    let market = ctx.accounts.market.key();
    let bump = [ctx.bumps.market_authority];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, market.as_ref(), &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.market_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                authority: ctx.accounts.market_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    *free = remaining;
    ctx.accounts.asset_balance.free = shared_free;
    Ok(())
}

#[derive(Accounts)]
pub struct MigratePredictionAsset<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut, seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump = position.bump,
        has_one = owner @ shared::InvalidAssetBalance, has_one = market @ shared::InvalidAssetBalance)]
    pub position: Account<'info, PredictionPosition>,
    #[account(address = market.collateral_mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [ASSET_BALANCE_SEED, owner.key().as_ref(), mint.key().as_ref()], bump = asset_balance.bump,
        has_one = owner @ shared::InvalidAssetBalance, has_one = mint @ shared::InvalidAssetBalance)]
    pub asset_balance: Account<'info, AssetBalance>,
    /// CHECK: Legacy question's reserve/cash vault authority.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub market_authority: UncheckedAccount<'info>,
    #[account(mut, address = market.collateral_vault,
        seeds = [VAULT_SEED, market.key().as_ref(), mint.key().as_ref()], bump,
        token::mint = mint, token::authority = market_authority)]
    pub market_vault: Account<'info, TokenAccount>,
    /// CHECK: Mint-specific shared destination authority.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub asset_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = asset_authority)]
    pub asset_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Moves only a question's legacy free cash into the owner's global collateral balance.
///
/// # Inputs
/// Owner signer, position, bound collateral mint, two canonical vaults and positive atoms.
/// # Errors
/// Wrong binding, insufficient free cash, overflow or failed transfer.
/// # Returns
/// `Ok(())` after equal claim/custody movement. Reserves, outcomes and locked cash are untouched.
pub fn handle_migrate_prediction_asset(
    ctx: Context<MigratePredictionAsset>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, balance::InvalidDepositAmount);
    let remaining = ctx
        .accounts
        .position
        .collateral_free
        .checked_sub(amount)
        .ok_or(balance::InsufficientFreeBalance)?;
    let free = ctx
        .accounts
        .asset_balance
        .free
        .checked_add(amount)
        .ok_or(balance::FreeBalanceOverflow)?;
    let market = ctx.accounts.market.key();
    let bump = [ctx.bumps.market_authority];
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, market.as_ref(), &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.market_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                authority: ctx.accounts.market_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    ctx.accounts.position.collateral_free = remaining;
    ctx.accounts.asset_balance.free = free;
    Ok(())
}
