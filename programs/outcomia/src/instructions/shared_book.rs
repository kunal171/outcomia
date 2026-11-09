//! Admin setup and fee custody for the new global-wallet execution root.
//! A distinct namespace preserves legacy queues and their original backing.
use crate::{
    constants::*,
    errors::{admin, balance, shared},
    shared_trading,
    state::*,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
pub struct InitializeSharedBook<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump,
        has_one = authority @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Account<'info, AdminRecord>,
    /// CHECK: Handler decodes the selected account type and validates its canonical PDA/creator.
    #[account(owner = crate::ID)]
    pub market: UncheckedAccount<'info>,
    #[account(init, payer = authority, space = 8 + SharedBook::INIT_SPACE,
        seeds = [SHARED_BOOK_SEED, market.key().as_ref()], bump)]
    pub book: Box<Account<'info, SharedBook>>,
    pub system_program: Program<'info, System>,
}

/// Creates a separate shared-wallet book without moving legacy funds or queues.
///
/// # Inputs
/// Active-admin stored authority, underlying market, new root and economic kind.
/// # Errors
/// Foreign creator, wrong kind/PDA, duplicate root, malformed terms or account rent failure.
/// # Returns
/// Empty four-head index with next ID 1, zero fees and immutable mint/grid bindings.
pub fn handle_initialize_shared_book(
    ctx: Context<InitializeSharedBook>,
    kind: MarketKind,
) -> Result<()> {
    let value = shared_trading::terms(&ctx.accounts.market.to_account_info(), kind, false)?;
    require_keys_eq!(
        value.authority,
        ctx.accounts.authority.key(),
        admin::UnauthorizedAdmin
    );
    require!(value.tick > 0 && value.lot > 0, shared::InvalidSharedBook);
    ctx.accounts.book.set_inner(SharedBook {
        market: ctx.accounts.market.key(),
        authority: value.authority,
        kind,
        base_mint: value.base_mint,
        quote_mint: value.quote_mint,
        base_decimals: value.base_decimals,
        quote_decimals: value.quote_decimals,
        price_tick: value.tick,
        quantity_lot: value.lot,
        payout_per_contract: value.payout,
        best_prices: [None; 4],
        next_order_id: 1,
        open_order_count: 0,
        accrued_quote_fees: 0,
        bump: ctx.bumps.book,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawSharedFees<'info> {
    pub super_admin: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump,
        has_one = super_admin @ admin::UnauthorizedAdmin)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [SHARED_BOOK_SEED, book.market.as_ref()], bump = book.bump)]
    pub book: Account<'info, SharedBook>,
    #[account(address = book.quote_mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = super_admin)]
    pub destination: Account<'info, TokenAccount>,
    /// CHECK: Mint-specific global vault authority.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = vault_authority)]
    pub asset_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Withdraws only this book's earned fees, never traders' free/locked claims or reserves.
///
/// # Inputs
/// Super-admin signer/config, book, quote mint, global vault and owned destination; positive atoms.
/// # Errors
/// Unauthorized caller, wrong custody, excess fee withdrawal, zero amount or CPI failure.
/// # Returns
/// `Ok(())` with fee claim and physical quote custody decreased equally.
pub fn handle_withdraw_shared_fees(ctx: Context<WithdrawSharedFees>, amount: u64) -> Result<()> {
    require!(amount > 0, balance::InvalidWithdrawalAmount);
    let fees = ctx
        .accounts
        .book
        .accrued_quote_fees
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
    ctx.accounts.book.accrued_quote_fees = fees;
    Ok(())
}

#[derive(Accounts)]
pub struct CloseSharedBook<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump,
        has_one = authority @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Account<'info, AdminRecord>,
    /// CHECK: Handler verifies source identity, authority and shutdown state.
    #[account(owner = crate::ID)]
    pub market: UncheckedAccount<'info>,
    #[account(mut, close = authority, seeds = [SHARED_BOOK_SEED, market.key().as_ref()], bump = book.bump,
        has_one = market @ shared::InvalidSharedBook, has_one = authority @ admin::UnauthorizedAdmin)]
    pub book: Account<'info, SharedBook>,
}
/// Closes a drained shared book before source-market shutdown.
/// # Inputs
/// Active-admin creator, source market and canonical root.
/// # Errors
/// Nonempty orders/fees/index, foreign creator, or source still trading/unresolved.
/// # Returns
/// Root rent to creator. Historical orders remain and must never be overwritten on root recreation.
pub fn handle_close_shared_book(ctx: Context<CloseSharedBook>) -> Result<()> {
    let b = &ctx.accounts.book;
    require!(
        b.open_order_count == 0
            && b.accrued_quote_fees == 0
            && b.best_prices.iter().all(Option::is_none),
        shared::SharedBookNotEmpty
    );
    let data = ctx.accounts.market.try_borrow_data()?;
    match b.kind {
        MarketKind::Spot => {
            let m = Market::try_deserialize(&mut data.as_ref())?;
            require!(
                m.status == MarketStatus::Paused,
                crate::errors::market::MarketMustBePaused
            );
        }
        MarketKind::Prediction => {
            let m = PredictionMarket::try_deserialize(&mut data.as_ref())?;
            require!(
                m.status == PredictionStatus::Resolved,
                shared::PredictionNotResolved
            );
        }
        _ => return err!(shared::SharedMarketKindMismatch),
    }
    Ok(())
}
