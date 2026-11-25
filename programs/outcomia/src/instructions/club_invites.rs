//! Invite-then-accept membership.
//!
//! A club admin invites a wallet; the wallet joins only by signing the accept.
//! Invitations last seven days. Any admin may revoke one and the invited wallet
//! may decline it; once expired, anyone may close it. Rent always returns to
//! the inviter. An invitation belongs to the club, so it stays valid if its
//! inviter later stops being an admin; other admins can revoke it.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        CLUB_INVITE_SEED, CLUB_INVITE_TTL_SECONDS, CLUB_MEMBER_SEED, CLUB_RULES_CONFIG_SEED,
    },
    errors::club,
    state::{Club, ClubInvite, ClubMember, ClubRole, ClubRulesConfig},
};

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct InviteClubMember<'info> {
    #[account(mut)]
    pub inviter: Signer<'info>,
    pub club: Account<'info, Club>,
    #[account(seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), inviter.key().as_ref()],
        bump = inviter_member.bump,
        constraint = inviter_member.role == ClubRole::Admin @ club::UnauthorizedClubAdmin)]
    pub inviter_member: Account<'info, ClubMember>,
    /// CHECK: The invited wallet's membership PDA; it must not exist yet.
    #[account(seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), wallet.as_ref()], bump,
        constraint = existing_member.data_is_empty() @ club::AlreadyClubMember)]
    pub existing_member: UncheckedAccount<'info>,
    #[account(init, payer = inviter, space = 8 + ClubInvite::INIT_SPACE,
        seeds = [CLUB_INVITE_SEED, club.key().as_ref(), wallet.as_ref()], bump)]
    pub invite: Account<'info, ClubInvite>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptClubInvite<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut)]
    pub club: Account<'info, Club>,
    #[account(seeds = [CLUB_RULES_CONFIG_SEED], bump = club_rules.bump)]
    pub club_rules: Account<'info, ClubRulesConfig>,
    #[account(mut, close = inviter, has_one = wallet @ club::InvalidClubMember,
        seeds = [CLUB_INVITE_SEED, club.key().as_ref(), wallet.key().as_ref()],
        bump = invite.bump)]
    pub invite: Account<'info, ClubInvite>,
    /// CHECK: Receives the invitation rent; bound to the stored inviter.
    #[account(mut, address = invite.inviter @ club::InvalidClubMember)]
    pub inviter: UncheckedAccount<'info>,
    #[account(init, payer = wallet, space = 8 + ClubMember::INIT_SPACE,
        seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), wallet.key().as_ref()], bump)]
    pub member: Account<'info, ClubMember>,
    pub system_program: Program<'info, System>,
}

/// Revoke (club admin), decline (invited wallet) or close after expiry (anyone).
#[derive(Accounts)]
pub struct CloseClubInvite<'info> {
    pub closer: Signer<'info>,
    #[account(mut, close = inviter,
        seeds = [CLUB_INVITE_SEED, invite.club.as_ref(), invite.wallet.as_ref()],
        bump = invite.bump)]
    pub invite: Account<'info, ClubInvite>,
    /// CHECK: Receives the invitation rent; bound to the stored inviter.
    #[account(mut, address = invite.inviter @ club::InvalidClubMember)]
    pub inviter: UncheckedAccount<'info>,
    /// The closer's membership, required only when revoking as an admin.
    pub closer_member: Option<Account<'info, ClubMember>>,
}

/// Invites a wallet that is not yet a member.
///
/// # Inputs
/// A current club admin (paying rent), the wallet's empty membership PDA and the new invitation.
/// # Errors
/// Signer is not an admin, the wallet is already a member or an invitation is already pending.
/// # Returns
/// An invitation that the wallet can accept for `CLUB_INVITE_TTL_SECONDS`.
pub fn handle_invite_club_member(ctx: Context<InviteClubMember>, wallet: Pubkey) -> Result<()> {
    let expires_at = Clock::get()?
        .unix_timestamp
        .checked_add(CLUB_INVITE_TTL_SECONDS)
        .ok_or(club::ClubCounterMismatch)?;
    ctx.accounts.invite.set_inner(ClubInvite {
        club: ctx.accounts.club.key(),
        wallet,
        inviter: ctx.accounts.inviter.key(),
        expires_at,
        bump: ctx.bumps.invite,
    });
    Ok(())
}

/// Joins the club with the `Member` role.
///
/// # Inputs
/// The invited wallet (paying membership rent), its unexpired invitation and the inviter.
/// # Errors
/// Expired or foreign invitation, or counter overflow.
/// # Returns
/// A membership record; the invitation closes and its rent returns to the inviter.
pub fn handle_accept_club_invite(ctx: Context<AcceptClubInvite>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now < ctx.accounts.invite.expires_at,
        club::ClubInviteExpired
    );
    let club = &mut ctx.accounts.club;
    club.admit(&ctx.accounts.club_rules)?;
    ctx.accounts.member.set_inner(ClubMember {
        club: club.key(),
        wallet: ctx.accounts.wallet.key(),
        role: ClubRole::Member,
        joined_at: now,
        bump: ctx.bumps.member,
    });
    Ok(())
}

/// Closes an invitation, returning its rent to the inviter.
///
/// # Inputs
/// Any signer; the closer's own membership when acting as a club admin.
/// # Errors
/// `ClubInviteNotExpired` when a signer who is neither the invited wallet nor a current admin of
/// the invitation's club closes it before expiry.
/// # Returns
/// `Ok(())` after the invitation is closed.
pub fn handle_close_club_invite(ctx: Context<CloseClubInvite>) -> Result<()> {
    let closer = ctx.accounts.closer.key();
    let invite = &ctx.accounts.invite;
    let is_admin =
        ctx.accounts.closer_member.as_ref().is_some_and(|m| {
            m.club == invite.club && m.wallet == closer && m.role == ClubRole::Admin
        });
    let expired = Clock::get()?.unix_timestamp >= invite.expires_at;
    require!(
        closer == invite.wallet || is_admin || expired,
        club::ClubInviteNotExpired
    );
    Ok(())
}
