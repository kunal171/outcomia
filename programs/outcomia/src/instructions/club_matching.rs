//! Direct and complementary fills on club books.
//!
//! Fills reuse the shared matching code. In members-only markets both the
//! taker and the maker must be current members: a removed member's resting
//! order cannot fill (anyone may cancel it instead). Traders pay the normal
//! taker fee; the protocol-wide club share of it moves from the book's fee
//! claim to the club market's, so the global vault still equals all claims
//! plus book fees plus club fees.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use super::{
    club_markets::require_club_access,
    shared_complement::{match_complement, Backing, ComplementAccounts},
    shared_match::{match_order, MatchAccounts},
};
use crate::{
    constants::*,
    errors::{club, fee, shared},
    fees::split_club_fee,
    shared_trading as rules,
    state::*,
};

/// Reads the club fee share; zero until the super-admin creates the config.
/// The account is the canonical PDA, so a taker cannot omit it to avoid the split.
fn club_share_bps(config: &UncheckedAccount) -> Result<u16> {
    if config.data_is_empty() {
        return Ok(0);
    }
    require_keys_eq!(*config.owner, crate::ID, club::InvalidClubMarket);
    let data = config.try_borrow_data()?;
    Ok(ClubFeeConfig::try_deserialize(&mut data.as_ref())?.club_share_bps)
}

/// Moves the club share of an accrued taker fee from the book to the club.
fn credit_club_fee(
    book: &mut SharedBook,
    club_market: &mut ClubMarket,
    fee: u64,
    share_bps: u16,
) -> Result<()> {
    let (club_part, _) = split_club_fee(fee, share_bps)?;
    book.accrued_quote_fees = book
        .accrued_quote_fees
        .checked_sub(club_part)
        .ok_or(shared::InvalidSharedBook)?;
    club_market.accrued_club_fees = club_market
        .accrued_club_fees
        .checked_add(club_part)
        .ok_or(fee::FeeAccrualOverflow)?;
    Ok(())
}

/// Membership of both parties in members-only markets.
fn check_parties(
    club_market: &ClubMarket,
    taker: Pubkey,
    taker_member: Option<&ClubMember>,
    maker: Pubkey,
    maker_member: Option<&ClubMember>,
) -> Result<()> {
    require_club_access(club_market, taker_member, taker)?;
    require_club_access(club_market, maker_member, maker)
}

#[derive(Accounts)]
pub struct MatchClubOrder<'info> {
    pub taker: Signer<'info>,
    /// CHECK: Club market; `club_trading_open` checks its seed and trading window.
    #[account(owner = crate::ID)]
    pub market: UncheckedAccount<'info>,
    #[account(mut, seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump = club_market.bump,
        has_one = market @ club::InvalidClubMarket)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    #[account(mut, seeds = [CLUB_BOOK_SEED, market.key().as_ref()], bump = book.bump,
        has_one = market @ shared::InvalidSharedBook)]
    pub book: Box<Account<'info, SharedBook>>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    /// CHECK: Canonical club fee config; may not exist yet (share zero).
    #[account(seeds = [CLUB_FEE_CONFIG_SEED], bump)]
    pub club_fee_config: UncheckedAccount<'info>,
    pub taker_member: Option<Box<Account<'info, ClubMember>>>,
    pub maker_member: Option<Box<Account<'info, ClubMember>>>,
    #[account(mut)]
    pub maker_order: Box<Account<'info, SharedOrder>>,
    #[account(mut)]
    pub price_level: Box<Account<'info, SharedPriceLevel>>,
    #[account(mut)]
    pub maker_base: Option<Box<Account<'info, AssetBalance>>>,
    #[account(mut)]
    pub maker_quote: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub maker_position: Option<Box<Account<'info, PredictionPosition>>>,
    #[account(mut)]
    pub taker_base: Option<Box<Account<'info, AssetBalance>>>,
    #[account(mut)]
    pub taker_quote: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub taker_position: Option<Box<Account<'info, PredictionPosition>>>,
    #[account(mut)]
    pub next_order: Option<Box<Account<'info, SharedOrder>>>,
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    /// CHECK: Bound to the original level payer when its final maker is removed.
    #[account(mut)]
    pub level_rent_recipient: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct MatchClubComplement<'info> {
    pub taker: Signer<'info>,
    #[account(mut, seeds = [CLUB_PREDICTION_MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut, seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump = club_market.bump,
        has_one = market @ club::InvalidClubMarket)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    #[account(mut, seeds = [CLUB_BOOK_SEED, market.key().as_ref()], bump = book.bump,
        has_one = market @ shared::InvalidSharedBook)]
    pub book: Box<Account<'info, SharedBook>>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    /// CHECK: Canonical club fee config; may not exist yet (share zero).
    #[account(seeds = [CLUB_FEE_CONFIG_SEED], bump)]
    pub club_fee_config: UncheckedAccount<'info>,
    pub taker_member: Option<Box<Account<'info, ClubMember>>>,
    pub maker_member: Option<Box<Account<'info, ClubMember>>>,
    #[account(mut)]
    pub maker_order: Box<Account<'info, SharedOrder>>,
    #[account(mut)]
    pub price_level: Box<Account<'info, SharedPriceLevel>>,
    #[account(mut)]
    pub maker_quote: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub maker_position: Box<Account<'info, PredictionPosition>>,
    #[account(mut)]
    pub taker_quote: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub taker_position: Box<Account<'info, PredictionPosition>>,
    #[account(address = market.collateral_mint)]
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: Stateless PDA that signs for the global asset vault.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub asset_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = asset_authority)]
    pub asset_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: Stateless PDA that signs for the question's reserve vault.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub market_authority: UncheckedAccount<'info>,
    #[account(mut, address = market.collateral_vault,
        seeds = [VAULT_SEED, market.key().as_ref(), mint.key().as_ref()], bump,
        token::mint = mint, token::authority = market_authority)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(mut)]
    pub next_order: Option<Box<Account<'info, SharedOrder>>>,
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    /// CHECK: Bound to the original level payer when its final maker is removed.
    #[account(mut)]
    pub level_rent_recipient: Option<UncheckedAccount<'info>>,
}

/// Fills the best FIFO maker of the same outcome on a club book.
///
/// # Errors
/// Missing taker or maker membership in a members-only market, closed trading, plus every shared
/// fill error.
/// # Returns
/// The shared fill, with the club share of the taker fee credited to the club market.
pub fn handle_match_club_order(
    ctx: Context<MatchClubOrder>,
    outcome: SharedOutcome,
    taker_side: OrderSide,
    limit_price: u64,
    quantity: u64,
) -> Result<()> {
    rules::club_trading_open(&ctx.accounts.book, &ctx.accounts.market.to_account_info())?;
    let share_bps = club_share_bps(&ctx.accounts.club_fee_config)?;
    let accounts = &mut *ctx.accounts;
    check_parties(
        &accounts.club_market,
        accounts.taker.key(),
        accounts.taker_member.as_deref().map(|m| &**m),
        accounts.maker_order.owner,
        accounts.maker_member.as_deref().map(|m| &**m),
    )?;
    let fee = match_order(
        &mut MatchAccounts {
            taker: accounts.taker.key(),
            taker_fee_bps: accounts.protocol_config.taker_fee_bps,
            book: &mut accounts.book,
            maker_order: &mut accounts.maker_order,
            price_level: &mut accounts.price_level,
            maker_base: &mut accounts.maker_base,
            maker_quote: &mut accounts.maker_quote,
            maker_position: &mut accounts.maker_position,
            taker_base: &mut accounts.taker_base,
            taker_quote: &mut accounts.taker_quote,
            taker_position: &mut accounts.taker_position,
            next_order: &mut accounts.next_order,
            worse_level: &mut accounts.worse_level,
            level_rent_recipient: &accounts.level_rent_recipient,
        },
        outcome,
        taker_side,
        limit_price,
        quantity,
    )?;
    credit_club_fee(
        &mut accounts.book,
        &mut accounts.club_market,
        fee,
        share_bps,
    )
}

/// Fills the best FIFO maker of the other outcome through the complete set.
///
/// # Errors
/// Missing taker or maker membership in a members-only market, closed trading, plus every shared
/// complementary fill error.
/// # Returns
/// The shared mint or merge, with the club share of the taker fee credited to the club market.
pub fn handle_match_club_complement(
    ctx: Context<MatchClubComplement>,
    outcome: SharedOutcome,
    taker_side: OrderSide,
    limit_price: u64,
    quantity: u64,
) -> Result<()> {
    rules::club_trading_open(&ctx.accounts.book, &ctx.accounts.market.to_account_info())?;
    let share_bps = club_share_bps(&ctx.accounts.club_fee_config)?;
    let accounts = &mut *ctx.accounts;
    check_parties(
        &accounts.club_market,
        accounts.taker.key(),
        accounts.taker_member.as_deref().map(|m| &**m),
        accounts.maker_order.owner,
        accounts.maker_member.as_deref().map(|m| &**m),
    )?;
    let backing = Backing {
        market: accounts.market.key(),
        mint: accounts.mint.to_account_info(),
        decimals: accounts.mint.decimals,
        asset_authority: accounts.asset_authority.to_account_info(),
        asset_authority_bump: ctx.bumps.asset_authority,
        asset_vault: accounts.asset_vault.to_account_info(),
        market_authority: accounts.market_authority.to_account_info(),
        market_authority_bump: ctx.bumps.market_authority,
        market_vault: accounts.market_vault.to_account_info(),
        token_program: accounts.token_program.key(),
    };
    let fee = match_complement(
        &mut ComplementAccounts {
            taker: accounts.taker.key(),
            taker_fee_bps: accounts.protocol_config.taker_fee_bps,
            market: &mut accounts.market,
            book: &mut accounts.book,
            maker_order: &mut accounts.maker_order,
            price_level: &mut accounts.price_level,
            maker_quote: &mut accounts.maker_quote,
            maker_position: &mut accounts.maker_position,
            taker_quote: &mut accounts.taker_quote,
            taker_position: &mut accounts.taker_position,
            next_order: &mut accounts.next_order,
            worse_level: &mut accounts.worse_level,
            level_rent_recipient: &accounts.level_rent_recipient,
            backing,
        },
        outcome,
        taker_side,
        limit_price,
        quantity,
    )?;
    credit_club_fee(
        &mut accounts.book,
        &mut accounts.club_market,
        fee,
        share_bps,
    )
}
