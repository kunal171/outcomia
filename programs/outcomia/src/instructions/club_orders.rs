//! Club books: creation, order placement and cancellation.
//!
//! Club books use the shared book layout at ["club_book", market]; orders and
//! levels live under the book's address, so they never mix with public
//! queues. Placement in a members-only market requires current membership.
//! The owner can always cancel. If the owner of an order in a members-only
//! market is no longer a member, anyone may cancel it: its funds return to the
//! owner, and a departed member cannot block the queue with an unfillable head.

use anchor_lang::prelude::*;

use super::{
    club_markets::require_club_access,
    shared_orders::{cancel_order, place_order, CancelAccounts, PlaceAccounts},
};
use crate::{constants::*, errors::club, errors::shared, shared_trading as rules, state::*};

#[derive(Accounts)]
pub struct InitializeClubBook<'info> {
    #[account(mut)]
    pub actor: Signer<'info>,
    #[account(seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump = club_market.bump,
        has_one = market @ club::InvalidClubMarket)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    /// CHECK: Must be the club market bound above; the handler reads its terms.
    #[account(owner = crate::ID)]
    pub market: UncheckedAccount<'info>,
    #[account(seeds = [CLUB_MEMBER_SEED, club_market.club.as_ref(), actor.key().as_ref()],
        bump = actor_member.bump,
        constraint = actor_member.role == ClubRole::Admin
            || actor_member.wallet == club_market.creator @ club::UnauthorizedClubAdmin)]
    pub actor_member: Box<Account<'info, ClubMember>>,
    #[account(init, payer = actor, space = 8 + SharedBook::INIT_SPACE,
        seeds = [CLUB_BOOK_SEED, market.key().as_ref()], bump)]
    pub book: Box<Account<'info, SharedBook>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(outcome: SharedOutcome, side: OrderSide, price: u64, quantity: u64, order_id: u64)]
pub struct PlaceClubOrder<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Club market; `club_trading_open` checks its seed and trading window.
    #[account(owner = crate::ID)]
    pub market: UncheckedAccount<'info>,
    #[account(seeds = [CLUB_MARKET_SEED, market.key().as_ref()], bump = club_market.bump,
        has_one = market @ club::InvalidClubMarket)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    /// The owner's membership; required in members-only markets.
    pub member: Option<Box<Account<'info, ClubMember>>>,
    #[account(mut, seeds = [CLUB_BOOK_SEED, market.key().as_ref()], bump = book.bump,
        has_one = market @ shared::InvalidSharedBook)]
    pub book: Box<Account<'info, SharedBook>>,
    #[account(mut)]
    pub base_balance: Option<Box<Account<'info, AssetBalance>>>,
    #[account(mut)]
    pub quote_balance: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub position: Option<Box<Account<'info, PredictionPosition>>>,
    #[account(init, payer = owner, space = 8 + SharedOrder::INIT_SPACE,
        seeds = [SHARED_ORDER_SEED, book.key().as_ref(), &order_id.to_le_bytes()], bump)]
    pub order: Box<Account<'info, SharedOrder>>,
    #[account(init_if_needed, payer = owner, space = 8 + SharedPriceLevel::INIT_SPACE,
        seeds = [SHARED_LEVEL_SEED, book.key().as_ref(), outcome.seed(), side.seed(), &price.to_le_bytes()], bump)]
    pub price_level: Box<Account<'info, SharedPriceLevel>>,
    #[account(mut)]
    pub tail: Option<Box<Account<'info, SharedOrder>>>,
    #[account(mut)]
    pub better_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelClubOrder<'info> {
    /// The order owner, or anyone when the owner has left a members-only club market.
    pub canceller: Signer<'info>,
    #[account(seeds = [CLUB_MARKET_SEED, book.market.as_ref()], bump = club_market.bump)]
    pub club_market: Box<Account<'info, ClubMarket>>,
    #[account(mut, seeds = [CLUB_BOOK_SEED, book.market.as_ref()], bump = book.bump)]
    pub book: Box<Account<'info, SharedBook>>,
    /// CHECK: The order owner's membership PDA; only its emptiness is read.
    #[account(seeds = [CLUB_MEMBER_SEED, club_market.club.as_ref(), order.owner.as_ref()], bump)]
    pub owner_member: UncheckedAccount<'info>,
    #[account(mut)]
    pub base_balance: Option<Box<Account<'info, AssetBalance>>>,
    #[account(mut)]
    pub quote_balance: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub position: Option<Box<Account<'info, PredictionPosition>>>,
    #[account(mut)]
    pub order: Box<Account<'info, SharedOrder>>,
    #[account(mut)]
    pub price_level: Box<Account<'info, SharedPriceLevel>>,
    #[account(mut)]
    pub previous_order: Option<Box<Account<'info, SharedOrder>>>,
    #[account(mut)]
    pub next_order: Option<Box<Account<'info, SharedOrder>>>,
    #[account(mut)]
    pub better_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    /// CHECK: Validated against the stored level rent payer, only when closing that level.
    #[account(mut)]
    pub level_rent_recipient: Option<UncheckedAccount<'info>>,
}

/// Creates the club market's book.
///
/// # Inputs
/// A club admin or the creator-member (paying rent), the club binding and the market.
/// # Errors
/// Unauthorized signer, a non-club market, malformed terms or an existing book.
/// # Returns
/// An empty prediction book bound to the market's immutable terms.
pub fn handle_initialize_club_book(ctx: Context<InitializeClubBook>) -> Result<()> {
    let value = rules::club_terms(&ctx.accounts.market.to_account_info(), false)?;
    require!(value.tick > 0 && value.lot > 0, shared::InvalidSharedBook);
    ctx.accounts.book.set_inner(SharedBook {
        market: ctx.accounts.market.key(),
        authority: value.authority,
        kind: MarketKind::Prediction,
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

/// Places a resting order on a club book.
///
/// # Errors
/// Missing membership in a members-only market, closed trading, plus every shared placement error.
/// # Returns
/// The same locks, queue updates and counters as a public shared placement.
pub fn handle_place_club_order(
    ctx: Context<PlaceClubOrder>,
    outcome: SharedOutcome,
    side: OrderSide,
    price: u64,
    quantity: u64,
    order_id: u64,
) -> Result<()> {
    rules::club_trading_open(&ctx.accounts.book, &ctx.accounts.market.to_account_info())?;
    let accounts = &mut *ctx.accounts;
    require_club_access(
        &accounts.club_market,
        accounts.member.as_deref().map(|m| &**m),
        accounts.owner.key(),
    )?;
    place_order(
        &mut PlaceAccounts {
            owner: accounts.owner.key(),
            book: &mut accounts.book,
            base_balance: &mut accounts.base_balance,
            quote_balance: &mut accounts.quote_balance,
            position: &mut accounts.position,
            order: &mut accounts.order,
            order_bump: ctx.bumps.order,
            price_level: &mut accounts.price_level,
            price_level_bump: ctx.bumps.price_level,
            tail: &mut accounts.tail,
            better_level: &mut accounts.better_level,
            worse_level: &mut accounts.worse_level,
        },
        outcome,
        side,
        price,
        quantity,
        order_id,
    )
}

/// Cancels a club order and refunds its owner.
///
/// # Errors
/// A signer other than the owner when the market is public or the owner is still a member, plus
/// every shared cancellation error.
/// # Returns
/// The owner's lock released to free balance; empty level rent to its original payer.
pub fn handle_cancel_club_order(ctx: Context<CancelClubOrder>) -> Result<()> {
    let accounts = &mut *ctx.accounts;
    let owner = accounts.order.owner;
    if accounts.canceller.key() != owner {
        require!(
            accounts.club_market.access == ClubMarketAccess::MembersOnly
                && accounts.owner_member.data_is_empty(),
            shared::UnauthorizedSharedOrderOwner
        );
    }
    cancel_order(&mut CancelAccounts {
        owner,
        book: &mut accounts.book,
        base_balance: &mut accounts.base_balance,
        quote_balance: &mut accounts.quote_balance,
        position: &mut accounts.position,
        order: &mut accounts.order,
        price_level: &mut accounts.price_level,
        previous_order: &mut accounts.previous_order,
        next_order: &mut accounts.next_order,
        better_level: &mut accounts.better_level,
        worse_level: &mut accounts.worse_level,
        level_rent_recipient: &accounts.level_rent_recipient,
    })
}
