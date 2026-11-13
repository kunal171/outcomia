//! Super-admin withdrawal of earned trading fees only; claims stay in global custody.
use crate::{
    constants::*,
    errors::{admin, balance, multi_outcome as multi},
    state::*,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
#[derive(Accounts)]
pub struct WithdrawMultiOutcomeFees<'info> {
    pub super_admin: Signer<'info>,
    #[account(seeds=[PROTOCOL_CONFIG_SEED],bump=protocol_config.bump,has_one=super_admin @ admin::UnauthorizedAdmin)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(seeds=[MULTI_OUTCOME_MARKET_SEED,market.market_id.as_ref()],bump=market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(mut,seeds=[MULTI_OUTCOME_BOOK_SEED,market.key().as_ref()],bump=book.bump,has_one=market @ multi::InvalidMultiOutcomeBook)]
    pub book: Box<Account<'info, MultiOutcomeBook>>,
    #[account(address=market.collateral_mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut,token::mint=mint,token::authority=super_admin)]
    pub destination: Account<'info, TokenAccount>,
    /// CHECK: Canonical global mint authority.
    #[account(seeds=[ASSET_AUTHORITY_SEED,mint.key().as_ref()],bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut,seeds=[ASSET_VAULT_SEED,mint.key().as_ref()],bump,token::mint=mint,token::authority=vault_authority)]
    pub asset_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
/// Inputs: super-admin, canonical book/global vault and owned destination, amount.
/// Errors: role/custody, zero/excess withdrawal or CPI. Returns: only accrued
/// fees and physical vault atoms decrease; traders' claims/reserve never debit.
pub fn handle_withdraw_multi_outcome_fees(
    ctx: Context<WithdrawMultiOutcomeFees>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, balance::InvalidWithdrawalAmount);
    let next = ctx
        .accounts
        .book
        .accrued_collateral_fees
        .checked_sub(amount)
        .ok_or(balance::InsufficientFreeBalance)?;
    let mint = ctx.accounts.mint.key();
    let bump = [ctx.bumps.vault_authority];
    let seeds: &[&[u8]] = &[ASSET_AUTHORITY_SEED, mint.as_ref(), &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;
    ctx.accounts.book.accrued_collateral_fees = next;
    emit!(crate::MultiOutcomeFeeWithdrawnEvent {
        market: ctx.accounts.market.key(),
        authority: ctx.accounts.super_admin.key(),
        amount
    });
    Ok(())
}
