//! Public and open clubs (Creator Clubs step CC1).
//!
//! A club owner lists the club as Public (request, then admin approval) or
//! Open (join directly) with a topic and description. A listing admits new
//! members only while a protocol admin has verified its current terms; any
//! change by the owner clears that verification, and closing the listing makes
//! the club private again. Join requests last seven days; the requester pays
//! their rent and always receives it back. The approving admin pays the new
//! membership's rent. Clubs without a listing behave exactly as before.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        ADMIN_SEED, CLUB_DESCRIPTION_MAX_LENGTH, CLUB_JOIN_REQUEST_SEED,
        CLUB_JOIN_REQUEST_TTL_SECONDS, CLUB_LISTING_SEED, CLUB_MEMBER_SEED,
        CLUB_REQUEST_NOTE_MAX_LENGTH, CLUB_TOPIC_MAX_LENGTH,
    },
    errors::{admin, club},
    state::{
        AdminRecord, AdminStatus, Club, ClubJoinRequest, ClubListing, ClubMember, ClubRole,
        ClubVisibility,
    },
};

fn trimmed(text: &str, max: usize, allow_empty: bool) -> bool {
    text.trim() == text && text.len() <= max && (allow_empty || !text.is_empty())
}

fn admits(listing: &ClubListing, club: &Pubkey, visibility: ClubVisibility) -> bool {
    listing.club == *club && listing.visibility == visibility && listing.verified_by.is_some()
}

fn add_member(club: &mut Club) -> Result<()> {
    club.member_count = club
        .member_count
        .checked_add(1)
        .ok_or(club::ClubCounterMismatch)?;
    Ok(())
}

#[derive(Accounts)]
pub struct SetClubListing<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one = owner @ club::UnauthorizedClubOwner)]
    pub club: Account<'info, Club>,
    #[account(init_if_needed, payer = owner, space = 8 + ClubListing::INIT_SPACE,
        seeds = [CLUB_LISTING_SEED, club.key().as_ref()], bump)]
    pub listing: Account<'info, ClubListing>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseClubListing<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(has_one = owner @ club::UnauthorizedClubOwner)]
    pub club: Account<'info, Club>,
    #[account(mut, close = owner, has_one = club @ club::InvalidClubMember,
        seeds = [CLUB_LISTING_SEED, club.key().as_ref()], bump = listing.bump)]
    pub listing: Account<'info, ClubListing>,
}

#[derive(Accounts)]
pub struct VerifyClubListing<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [ADMIN_SEED, authority.key().as_ref()], bump = admin_record.bump,
        has_one = authority @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled)]
    pub admin_record: Account<'info, AdminRecord>,
    #[account(mut, seeds = [CLUB_LISTING_SEED, listing.club.as_ref()], bump = listing.bump)]
    pub listing: Account<'info, ClubListing>,
}

#[derive(Accounts)]
pub struct RequestClubMembership<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    pub club: Account<'info, Club>,
    #[account(seeds = [CLUB_LISTING_SEED, club.key().as_ref()], bump = listing.bump)]
    pub listing: Account<'info, ClubListing>,
    /// CHECK: The wallet's membership PDA; it must not exist yet.
    #[account(seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), wallet.key().as_ref()], bump,
        constraint = existing_member.data_is_empty() @ club::AlreadyClubMember)]
    pub existing_member: UncheckedAccount<'info>,
    #[account(init, payer = wallet, space = 8 + ClubJoinRequest::INIT_SPACE,
        seeds = [CLUB_JOIN_REQUEST_SEED, club.key().as_ref(), wallet.key().as_ref()], bump)]
    pub request: Account<'info, ClubJoinRequest>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApproveClubRequest<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut)]
    pub club: Account<'info, Club>,
    #[account(seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), admin.key().as_ref()],
        bump = admin_member.bump,
        constraint = admin_member.role == ClubRole::Admin @ club::UnauthorizedClubAdmin)]
    pub admin_member: Account<'info, ClubMember>,
    #[account(mut, close = wallet, has_one = club @ club::InvalidClubMember,
        seeds = [CLUB_JOIN_REQUEST_SEED, club.key().as_ref(), request.wallet.as_ref()],
        bump = request.bump)]
    pub request: Account<'info, ClubJoinRequest>,
    /// CHECK: Receives the request rent; bound to the requesting wallet.
    #[account(mut, address = request.wallet @ club::InvalidClubMember)]
    pub wallet: UncheckedAccount<'info>,
    #[account(init, payer = admin, space = 8 + ClubMember::INIT_SPACE,
        seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), request.wallet.as_ref()], bump)]
    pub member: Account<'info, ClubMember>,
    pub system_program: Program<'info, System>,
}

/// Reject (club admin), cancel (requesting wallet) or clear after expiry (anyone).
#[derive(Accounts)]
pub struct CloseClubRequest<'info> {
    pub closer: Signer<'info>,
    #[account(mut, close = wallet,
        seeds = [CLUB_JOIN_REQUEST_SEED, request.club.as_ref(), request.wallet.as_ref()],
        bump = request.bump)]
    pub request: Account<'info, ClubJoinRequest>,
    /// CHECK: Receives the request rent; bound to the requesting wallet.
    #[account(mut, address = request.wallet @ club::InvalidClubMember)]
    pub wallet: UncheckedAccount<'info>,
    /// The closer's membership, required only when rejecting as an admin.
    pub closer_member: Option<Account<'info, ClubMember>>,
}

#[derive(Accounts)]
pub struct JoinOpenClub<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut)]
    pub club: Account<'info, Club>,
    #[account(seeds = [CLUB_LISTING_SEED, club.key().as_ref()], bump = listing.bump)]
    pub listing: Account<'info, ClubListing>,
    #[account(init, payer = wallet, space = 8 + ClubMember::INIT_SPACE,
        seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), wallet.key().as_ref()], bump)]
    pub member: Account<'info, ClubMember>,
    pub system_program: Program<'info, System>,
}

/// Creates or updates the club's listing.
///
/// # Inputs
/// The club owner (paying rent on first use), visibility, topic and description.
/// # Errors
/// Signer is not the owner, or the topic or description is untrimmed, empty
/// (topic only) or too long.
/// # Returns
/// A listing awaiting protocol-admin verification; any earlier verification is cleared.
pub fn handle_set_club_listing(
    ctx: Context<SetClubListing>,
    visibility: ClubVisibility,
    topic: String,
    description: String,
) -> Result<()> {
    require!(
        trimmed(&topic, CLUB_TOPIC_MAX_LENGTH, false)
            && trimmed(&description, CLUB_DESCRIPTION_MAX_LENGTH, true),
        club::InvalidClubListing
    );
    ctx.accounts.listing.set_inner(ClubListing {
        club: ctx.accounts.club.key(),
        visibility,
        topic,
        description,
        verified_by: None,
        updated_at: Clock::get()?.unix_timestamp,
        bump: ctx.bumps.listing,
    });
    Ok(())
}

/// Removes the listing; the club becomes private (invite-only) again.
///
/// # Inputs
/// The club owner, who receives the listing rent.
/// # Errors
/// Signer is not the owner.
/// # Returns
/// `Ok(())`. Pending requests stay until approved, rejected, cancelled or expired.
pub fn handle_close_club_listing(_ctx: Context<CloseClubListing>) -> Result<()> {
    Ok(())
}

/// Verifies (or withdraws verification of) the listing's current terms.
///
/// # Inputs
/// An active protocol admin and `verified`.
/// # Errors
/// Signer is not an active protocol admin.
/// # Returns
/// The listing, discoverable and admitting members only while verified.
pub fn handle_verify_club_listing(ctx: Context<VerifyClubListing>, verified: bool) -> Result<()> {
    ctx.accounts.listing.verified_by = verified.then(|| ctx.accounts.authority.key());
    Ok(())
}

/// Requests membership of a verified public club.
///
/// # Inputs
/// The requesting wallet (paying refundable rent) and an optional note.
/// # Errors
/// The club is not a verified public listing, the wallet is already a member,
/// a request is already pending, or the note is untrimmed or too long.
/// # Returns
/// A request that a club admin can approve for seven days.
pub fn handle_request_club_membership(
    ctx: Context<RequestClubMembership>,
    note: String,
) -> Result<()> {
    require!(
        admits(
            &ctx.accounts.listing,
            &ctx.accounts.club.key(),
            ClubVisibility::Public
        ),
        club::ClubNotPublic
    );
    require!(
        trimmed(&note, CLUB_REQUEST_NOTE_MAX_LENGTH, true),
        club::InvalidClubListing
    );
    let expires_at = Clock::get()?
        .unix_timestamp
        .checked_add(CLUB_JOIN_REQUEST_TTL_SECONDS)
        .ok_or(club::ClubCounterMismatch)?;
    ctx.accounts.request.set_inner(ClubJoinRequest {
        club: ctx.accounts.club.key(),
        wallet: ctx.accounts.wallet.key(),
        note,
        expires_at,
        bump: ctx.bumps.request,
    });
    Ok(())
}

/// Admits the requesting wallet with the `Member` role.
///
/// # Inputs
/// A current club admin (paying membership rent) and the unexpired request.
/// # Errors
/// Signer is not an admin, the request belongs to another club or has expired,
/// the wallet is already a member, or the counter overflows.
/// # Returns
/// A membership record; the request closes and its rent returns to the wallet.
pub fn handle_approve_club_request(ctx: Context<ApproveClubRequest>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now < ctx.accounts.request.expires_at,
        club::ClubJoinRequestExpired
    );
    add_member(&mut ctx.accounts.club)?;
    ctx.accounts.member.set_inner(ClubMember {
        club: ctx.accounts.club.key(),
        wallet: ctx.accounts.request.wallet,
        role: ClubRole::Member,
        joined_at: now,
        bump: ctx.bumps.member,
    });
    Ok(())
}

/// Closes a join request, returning its rent to the requesting wallet.
///
/// # Inputs
/// Any signer; the closer's own membership when rejecting as a club admin.
/// # Errors
/// `ClubJoinRequestNotExpired` when a signer who is neither the requesting
/// wallet nor a current admin of the request's club closes it before expiry.
/// # Returns
/// `Ok(())` after the request is closed.
pub fn handle_close_club_request(ctx: Context<CloseClubRequest>) -> Result<()> {
    let closer = ctx.accounts.closer.key();
    let request = &ctx.accounts.request;
    let is_admin =
        ctx.accounts.closer_member.as_ref().is_some_and(|m| {
            m.club == request.club && m.wallet == closer && m.role == ClubRole::Admin
        });
    let expired = Clock::get()?.unix_timestamp >= request.expires_at;
    require!(
        closer == request.wallet || is_admin || expired,
        club::ClubJoinRequestNotExpired
    );
    Ok(())
}

/// Joins a verified open club with the `Member` role.
///
/// # Inputs
/// The wallet (paying membership rent).
/// # Errors
/// The club is not a verified open listing, the wallet is already a member, or
/// the counter overflows.
/// # Returns
/// A membership record.
pub fn handle_join_open_club(ctx: Context<JoinOpenClub>) -> Result<()> {
    require!(
        admits(
            &ctx.accounts.listing,
            &ctx.accounts.club.key(),
            ClubVisibility::Open
        ),
        club::ClubNotOpen
    );
    add_member(&mut ctx.accounts.club)?;
    ctx.accounts.member.set_inner(ClubMember {
        club: ctx.accounts.club.key(),
        wallet: ctx.accounts.wallet.key(),
        role: ClubRole::Member,
        joined_at: Clock::get()?.unix_timestamp,
        bump: ctx.bumps.member,
    });
    Ok(())
}
