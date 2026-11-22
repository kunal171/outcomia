//! Member roles, removal and leaving.
//!
//! The owner promotes and demotes admins. Admins remove members; only the
//! owner removes admins. Anyone but the owner may leave. Closing a membership
//! returns its rent to the departing wallet. Assets are unaffected: exits never
//! depend on membership.

use anchor_lang::prelude::*;

use crate::{
    constants::CLUB_MEMBER_SEED,
    errors::club,
    state::{Club, ClubMember, ClubRole},
};

impl Club {
    /// Updates counters for a membership that is closing.
    pub(crate) fn release(&mut self, member: &ClubMember) -> Result<()> {
        self.member_count = self
            .member_count
            .checked_sub(1)
            .ok_or(club::ClubCounterMismatch)?;
        if member.role == ClubRole::Admin {
            self.admin_count = self
                .admin_count
                .checked_sub(1)
                .ok_or(club::ClubCounterMismatch)?;
        }
        if self.pending_owner == Some(member.wallet) {
            self.pending_owner = None;
        }
        Ok(())
    }

    /// Moves a member between roles, keeping `admin_count` exact.
    pub(crate) fn change_role(&mut self, member: &mut ClubMember, role: ClubRole) -> Result<()> {
        match (member.role, role) {
            (ClubRole::Member, ClubRole::Admin) => {
                self.admin_count = self
                    .admin_count
                    .checked_add(1)
                    .ok_or(club::ClubCounterMismatch)?
            }
            (ClubRole::Admin, ClubRole::Member) => {
                self.admin_count = self
                    .admin_count
                    .checked_sub(1)
                    .ok_or(club::ClubCounterMismatch)?
            }
            _ => {}
        }
        member.role = role;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct SetClubMemberRole<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ club::UnauthorizedClubOwner)]
    pub club: Account<'info, Club>,
    #[account(mut, seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), member.wallet.as_ref()],
        bump = member.bump,
        constraint = member.wallet != club.owner @ club::ClubOwnerProtected)]
    pub member: Account<'info, ClubMember>,
}

#[derive(Accounts)]
pub struct RemoveClubMember<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub club: Account<'info, Club>,
    #[account(seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), admin.key().as_ref()],
        bump = admin_member.bump,
        constraint = admin_member.role == ClubRole::Admin @ club::UnauthorizedClubAdmin)]
    pub admin_member: Account<'info, ClubMember>,
    #[account(mut, close = wallet,
        seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), wallet.key().as_ref()],
        bump = member.bump,
        constraint = member.wallet != club.owner @ club::ClubOwnerProtected)]
    pub member: Account<'info, ClubMember>,
    /// CHECK: The removed wallet; it only receives the membership rent.
    #[account(mut)]
    pub wallet: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct LeaveClub<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut, constraint = club.owner != wallet.key() @ club::ClubOwnerProtected)]
    pub club: Account<'info, Club>,
    #[account(mut, close = wallet,
        seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), wallet.key().as_ref()],
        bump = member.bump)]
    pub member: Account<'info, ClubMember>,
}

/// Promotes a member to admin or demotes an admin to member.
///
/// # Inputs
/// The club owner, a membership other than the owner's and the target role.
/// # Errors
/// Signer is not the owner, the target is the owner, or counters are inconsistent.
/// # Returns
/// `Ok(())` with the role stored; setting the current role is a no-op.
pub fn handle_set_club_member_role(ctx: Context<SetClubMemberRole>, role: ClubRole) -> Result<()> {
    let accounts = ctx.accounts;
    accounts.club.change_role(&mut accounts.member, role)
}

/// Removes a member immediately.
///
/// # Inputs
/// A current club admin, the target membership and its wallet (rent destination).
/// # Errors
/// Signer is not an admin, the target is the owner, or a non-owner admin targets another admin.
/// # Returns
/// `Ok(())` after the membership closes; it also clears a pending ownership nomination.
pub fn handle_remove_club_member(ctx: Context<RemoveClubMember>) -> Result<()> {
    let accounts = ctx.accounts;
    require!(
        accounts.member.role == ClubRole::Member || accounts.admin.key() == accounts.club.owner,
        club::UnauthorizedClubOwner
    );
    accounts.club.release(&accounts.member)
}

/// Leaves the club.
///
/// # Inputs
/// The departing member (not the owner) and its membership.
/// # Errors
/// The signer owns the club or is not a member.
/// # Returns
/// `Ok(())` after the membership closes and its rent returns to the wallet.
pub fn handle_leave_club(ctx: Context<LeaveClub>) -> Result<()> {
    let accounts = ctx.accounts;
    accounts.club.release(&accounts.member)
}
