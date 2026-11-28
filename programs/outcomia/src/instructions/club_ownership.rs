//! Two-step club ownership transfer.
//!
//! The owner nominates a current member, who becomes owner only by accepting.
//! Nominating the owner itself cancels a pending nomination. The previous owner
//! stays an admin member and may then leave or be removed by the new owner.

use anchor_lang::prelude::*;

use crate::{
    constants::{CLUB_MEMBER_SEED, CLUB_OWNER_SEED, CLUB_RULES_CONFIG_SEED},
    errors::club,
    state::{Club, ClubMember, ClubOwnerRecord, ClubRole, ClubRulesConfig},
};

#[derive(Accounts)]
pub struct NominateClubOwner<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ club::UnauthorizedClubOwner)]
    pub club: Account<'info, Club>,
    #[account(seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), candidate_member.wallet.as_ref()],
        bump = candidate_member.bump)]
    pub candidate_member: Account<'info, ClubMember>,
}

#[derive(Accounts)]
pub struct AcceptClubOwnership<'info> {
    #[account(mut)]
    pub candidate: Signer<'info>,
    #[account(mut,
        constraint = club.pending_owner == Some(candidate.key()) @ club::InvalidClubMember)]
    pub club: Account<'info, Club>,
    #[account(mut, seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), candidate.key().as_ref()],
        bump = candidate_member.bump)]
    pub candidate_member: Account<'info, ClubMember>,
    #[account(seeds = [CLUB_RULES_CONFIG_SEED], bump = club_rules.bump)]
    pub club_rules: Account<'info, ClubRulesConfig>,
    #[account(init_if_needed, payer = candidate, space = 8 + ClubOwnerRecord::INIT_SPACE,
        seeds = [CLUB_OWNER_SEED, candidate.key().as_ref()], bump)]
    pub candidate_record: Account<'info, ClubOwnerRecord>,
    #[account(mut, seeds = [CLUB_OWNER_SEED, club.owner.as_ref()], bump = previous_record.bump)]
    pub previous_record: Account<'info, ClubOwnerRecord>,
    pub system_program: Program<'info, System>,
}

/// Nominates a member as the next owner, or cancels by nominating the owner.
///
/// # Inputs
/// The club owner and the candidate's membership.
/// # Errors
/// Signer is not the owner, or the candidate is not a member of this club.
/// # Returns
/// `Ok(())` with `pending_owner` set (or cleared).
pub fn handle_nominate_club_owner(ctx: Context<NominateClubOwner>) -> Result<()> {
    ctx.accounts.club.require_open()?;
    let candidate = ctx.accounts.candidate_member.wallet;
    ctx.accounts.club.pending_owner = (candidate != ctx.accounts.owner.key()).then_some(candidate);
    Ok(())
}

/// Accepts a pending nomination and becomes the club owner.
///
/// # Inputs
/// The nominated member and its membership.
/// # Errors
/// The signer is not the pending nominee, already owns the maximum number of
/// clubs, would exceed the admin limit, or counters are inconsistent.
/// # Returns
/// `Ok(())` with the candidate as owner and admin; the previous owner remains an admin.
pub fn handle_accept_club_ownership(ctx: Context<AcceptClubOwnership>) -> Result<()> {
    ctx.accounts.club.require_open()?;
    let bump = ctx.bumps.candidate_record;
    let accounts = ctx.accounts;
    let max = accounts.club_rules.max_owned_clubs;
    accounts
        .candidate_record
        .take(accounts.candidate.key(), bump, max)?;
    accounts.previous_record.give_up()?;
    accounts.club.set_role(
        &mut accounts.candidate_member,
        ClubRole::Admin,
        &accounts.club_rules,
    )?;
    accounts.club.owner = accounts.candidate.key();
    accounts.club.pending_owner = None;
    Ok(())
}
