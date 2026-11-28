//! Switching a club's type, settling finished club markets and closing a club
//! (club rules milestone 2b).
//!
//! A closed club keeps its account: its id can never be reused, its markets
//! stay redeemable, and existing member records can only be closed. Closing
//! refunds the whole deposit to the owner, removes the listing, closes the
//! owner's membership and frees the owner's club slot.

use anchor_lang::prelude::*;
use anchor_spl::token::{close_account, transfer, CloseAccount, Token, TokenAccount, Transfer};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{constants::*, errors::club, state::*};

use super::club_deposits::{read_sol_usd_price, sol_payment_minimum, usd_to_token_units};

#[derive(Accounts)]
pub struct SetClubKind<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ club::UnauthorizedClubOwner)]
    pub club: Box<Account<'info, Club>>,
    #[account(seeds = [CLUB_RULES_CONFIG_SEED], bump = club_rules.bump)]
    pub club_rules: Box<Account<'info, ClubRulesConfig>>,
    /// CHECK: The club's listing PDA; closed (rent to the owner) when the club
    /// becomes private.
    #[account(mut, seeds = [CLUB_LISTING_SEED, club.key().as_ref()], bump)]
    pub listing: UncheckedAccount<'info>,
    /// Fresh Pyth SOL/USD price; required for a club whose deposit is SOL.
    pub price_update: Option<Box<Account<'info, PriceUpdateV2>>>,
    /// USDC refund accounts; required when a USDC club becomes private.
    #[account(mut, seeds = [CLUB_DEPOSIT_VAULT_SEED, club.key().as_ref()], bump)]
    pub deposit_vault: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut, token::authority = owner)]
    pub owner_token: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Option<Program<'info, Token>>,
}

/// Switches a club between private and public.
///
/// # Inputs
/// The owner, the club, the club rules, the listing PDA and, as the deposit
/// requires, a fresh SOL/USD price or the USDC refund accounts.
/// # Errors
/// - the club is closed, the type is unchanged or deposit rules are not set;
/// - to public: the deposit is below the public payment minimum (SOL with the
///   buffer at the current price);
/// - to private: more members than the private cap.
/// # Returns
/// `Ok(())` with the type changed. A club that becomes private loses its
/// listing, and the deposit above the private payment minimum is refunded.
pub fn handle_set_club_kind(ctx: Context<SetClubKind>, kind: ClubKind) -> Result<()> {
    let club = &ctx.accounts.club;
    club.require_open()?;
    require!(club.kind != kind, club::ClubKindUnchanged);
    let rules = &ctx.accounts.club_rules;
    require!(rules.deposits_configured(), club::ClubDepositRulesNotSet);
    let price = match club.deposit_asset {
        ClubDepositAsset::Sol => {
            let update = ctx
                .accounts
                .price_update
                .as_deref()
                .ok_or(club::ClubPriceUpdateRequired)?;
            Some(read_sol_usd_price(update, rules)?)
        }
        _ => None,
    };
    // What a club of the target type must hold, in the deposit's units.
    let target = match (club.deposit_asset, &price) {
        (ClubDepositAsset::None, _) => 0,
        (ClubDepositAsset::Usdc, _) => {
            usd_to_token_units(rules.min_deposit_usd(kind), rules.deposit_mint_decimals)?
        }
        (ClubDepositAsset::Sol, price) => sol_payment_minimum(
            rules,
            kind,
            price.as_ref().ok_or(club::ClubPriceUpdateRequired)?,
        )?,
    };

    match kind {
        ClubKind::Public => {
            require!(
                club.deposit_asset != ClubDepositAsset::None && club.deposit_amount >= target,
                club::ClubDepositTooLow
            );
        }
        ClubKind::Private => {
            require!(
                club.member_count <= rules.private_member_cap,
                club::ClubTooLargeForPrivate
            );
            let excess = club.deposit_amount.saturating_sub(target);
            if excess > 0 {
                refund(
                    &ctx.accounts.club,
                    &ctx.accounts.owner.to_account_info(),
                    ctx.accounts.deposit_vault.as_deref(),
                    ctx.accounts.owner_token.as_deref(),
                    ctx.accounts.token_program.as_ref(),
                    excess,
                )?;
                ctx.accounts.club.deposit_amount -= excess;
            }
            // After any token CPI: moving lamports by hand before a CPI that
            // names the owner would unbalance that CPI's accounts.
            close_listing(&ctx.accounts.listing, &ctx.accounts.owner.to_account_info())?;
        }
    }
    ctx.accounts.club.kind = kind;
    Ok(())
}

#[derive(Accounts)]
pub struct SettleClubMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub club: Box<Account<'info, Club>>,
    #[account(seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump = club_market.bump,
        has_one = club @ club::InvalidClubMarket, has_one = market @ club::InvalidClubMarket)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    #[account(seeds = [CLUB_PREDICTION_MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(init, payer = payer, space = 8 + ClubMarketSettlement::INIT_SPACE,
        seeds = [CLUB_MARKET_SETTLED_SEED, club_market.key().as_ref()], bump)]
    pub settlement: Box<Account<'info, ClubMarketSettlement>>,
    pub system_program: Program<'info, System>,
}

/// Settles a finished club market so it no longer blocks closing the club.
/// Anyone may call it; the caller pays the small settlement record.
///
/// # Inputs
/// The payer, the club, the market's club binding, the market and its new
/// settlement record.
/// # Errors
/// - the club's market count is not recorded yet;
/// - the market is neither resolved nor an unopened, empty draft past its
///   close time;
/// - its club fees are not withdrawn;
/// - it was already settled (the record exists).
/// # Returns
/// `Ok(())` with the record created and the club's live markets reduced by one.
/// Holders still redeem as before.
pub fn handle_settle_club_market(ctx: Context<SettleClubMarket>) -> Result<()> {
    require!(
        ctx.accounts.club.live_markets_ready,
        club::ClubMarketCountNotSet
    );
    let market = &ctx.accounts.market;
    let now = Clock::get()?.unix_timestamp;
    let finished = match market.status {
        PredictionStatus::Resolved => true,
        // A draft can never open after its close time; settle it only if empty.
        PredictionStatus::Draft => {
            now >= market.close_ts
                && market.yes_supply == 0
                && market.no_supply == 0
                && market.backing_reserve == 0
        }
        _ => false,
    };
    require!(finished, club::ClubMarketNotFinished);
    require!(
        ctx.accounts.club_market.accrued_club_fees == 0,
        club::ClubFeesNotWithdrawn
    );
    ctx.accounts.settlement.set_inner(ClubMarketSettlement {
        club_market: ctx.accounts.club_market.key(),
        settled_at: now,
        bump: ctx.bumps.settlement,
    });
    let club = &mut ctx.accounts.club;
    club.live_markets = club
        .live_markets
        .checked_sub(1)
        .ok_or(club::ClubCounterMismatch)?;
    Ok(())
}

#[derive(Accounts)]
pub struct CloseClub<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ club::UnauthorizedClubOwner)]
    pub club: Box<Account<'info, Club>>,
    #[account(mut, seeds = [CLUB_OWNER_SEED, owner.key().as_ref()], bump = owner_record.bump)]
    pub owner_record: Box<Account<'info, ClubOwnerRecord>>,
    #[account(mut, close = owner,
        seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), owner.key().as_ref()],
        bump = owner_member.bump)]
    pub owner_member: Box<Account<'info, ClubMember>>,
    /// CHECK: The club's listing PDA; closed (rent to the owner) if it exists.
    #[account(mut, seeds = [CLUB_LISTING_SEED, club.key().as_ref()], bump)]
    pub listing: UncheckedAccount<'info>,
    /// USDC refund accounts; required when the deposit is USDC.
    #[account(mut, seeds = [CLUB_DEPOSIT_VAULT_SEED, club.key().as_ref()], bump)]
    pub deposit_vault: Option<Box<Account<'info, TokenAccount>>>,
    #[account(mut, token::authority = owner)]
    pub owner_token: Option<Box<Account<'info, TokenAccount>>>,
    pub token_program: Option<Program<'info, Token>>,
}

/// Closes a club and refunds its whole deposit to the owner.
///
/// # Inputs
/// The owner, the club, the owner's club record and membership, the listing
/// PDA and, for a USDC deposit, the vault, the owner's token account and the
/// token program.
/// # Errors
/// - the club is already closed;
/// - its market count is not recorded, or a market is not settled yet;
/// - USDC refund accounts are missing.
/// # Returns
/// `Ok(())`. The deposit is refunded (USDC vault emptied and closed, or SOL
/// returned), the listing and the owner's membership are closed, the owner's
/// slot is freed and the club is marked closed. Other members leave as before.
pub fn handle_close_club(ctx: Context<CloseClub>) -> Result<()> {
    let club = &ctx.accounts.club;
    club.require_open()?;
    require!(club.live_markets_ready, club::ClubMarketCountNotSet);
    require!(club.live_markets == 0, club::ClubHasLiveMarkets);
    let owner = ctx.accounts.owner.to_account_info();

    match club.deposit_asset {
        ClubDepositAsset::None => {}
        ClubDepositAsset::Sol => refund(
            &ctx.accounts.club,
            &owner,
            None,
            None,
            None,
            club.deposit_amount,
        )?,
        ClubDepositAsset::Usdc => {
            let (Some(vault), Some(token), Some(program)) = (
                ctx.accounts.deposit_vault.as_deref(),
                ctx.accounts.owner_token.as_deref(),
                ctx.accounts.token_program.as_ref(),
            ) else {
                return err!(club::ClubRefundAccountsMissing);
            };
            // Everything in the vault goes back, including any stray transfers.
            let all = vault.amount;
            if all > 0 {
                refund(
                    &ctx.accounts.club,
                    &owner,
                    Some(vault),
                    Some(token),
                    Some(program),
                    all,
                )?;
            }
            let id = ctx.accounts.club.club_id;
            let bump = [ctx.accounts.club.bump];
            let seeds: &[&[u8]] = &[CLUB_SEED, id.as_ref(), &bump];
            close_account(CpiContext::new_with_signer(
                program.key(),
                CloseAccount {
                    account: vault.to_account_info(),
                    destination: owner.clone(),
                    authority: ctx.accounts.club.to_account_info(),
                },
                &[seeds],
            ))?;
        }
    }

    // After the token CPIs, for the same reason as in `handle_set_club_kind`.
    close_listing(&ctx.accounts.listing, &owner)?;
    let member = (*ctx.accounts.owner_member).clone();
    ctx.accounts.owner_record.give_up()?;
    let club = &mut ctx.accounts.club;
    club.release(&member)?;
    club.pending_owner = None;
    club.deposit_asset = ClubDepositAsset::None;
    club.deposit_amount = 0;
    club.closed = true;
    Ok(())
}

/// Closes the listing PDA if it exists, returning its rent to `owner`.
fn close_listing<'info>(listing: &AccountInfo<'info>, owner: &AccountInfo<'info>) -> Result<()> {
    if listing.data_is_empty() || listing.owner != &crate::ID {
        return Ok(());
    }
    let lamports = listing.lamports();
    **owner.try_borrow_mut_lamports()? = owner
        .lamports()
        .checked_add(lamports)
        .ok_or(club::ClubDepositOverflow)?;
    **listing.try_borrow_mut_lamports()? = 0;
    // The runtime lets an account change owner only once its data is zeroed.
    listing.try_borrow_mut_data()?.fill(0);
    listing.resize(0)?;
    listing.assign(&anchor_lang::system_program::ID);
    Ok(())
}

/// Pays `amount` of the club's deposit to the owner: lamports from the club
/// account, or tokens from the club's vault signed by the club.
fn refund<'info>(
    club: &Account<'info, Club>,
    owner: &AccountInfo<'info>,
    vault: Option<&Account<'info, TokenAccount>>,
    owner_token: Option<&Account<'info, TokenAccount>>,
    token_program: Option<&Program<'info, Token>>,
    amount: u64,
) -> Result<()> {
    match club.deposit_asset {
        ClubDepositAsset::Sol => {
            // Only the tracked deposit leaves; the account keeps its rent.
            let info = club.to_account_info();
            **info.try_borrow_mut_lamports()? = info
                .lamports()
                .checked_sub(amount)
                .ok_or(club::ClubDepositOverflow)?;
            **owner.try_borrow_mut_lamports()? = owner
                .lamports()
                .checked_add(amount)
                .ok_or(club::ClubDepositOverflow)?;
            Ok(())
        }
        ClubDepositAsset::Usdc => {
            let (Some(vault), Some(token), Some(program)) = (vault, owner_token, token_program)
            else {
                return err!(club::ClubRefundAccountsMissing);
            };
            let id = club.club_id;
            let bump = [club.bump];
            let seeds: &[&[u8]] = &[CLUB_SEED, id.as_ref(), &bump];
            transfer(
                CpiContext::new_with_signer(
                    program.key(),
                    Transfer {
                        from: vault.to_account_info(),
                        to: token.to_account_info(),
                        authority: club.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
            )
        }
        ClubDepositAsset::None => Ok(()),
    }
}
