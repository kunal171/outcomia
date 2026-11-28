//! Club creation and club-wide settings.
//!
//! Any wallet may create a club and becomes its owner. The owner also receives
//! an admin membership record so every club check can rely on `ClubMember`.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        CLUB_MEMBER_SEED, CLUB_NAME_MAX_LENGTH, CLUB_OWNER_SEED, CLUB_RULES_CONFIG_SEED, CLUB_SEED,
    },
    errors::club,
    state::{
        Club, ClubDepositAsset, ClubKind, ClubMarketPolicy, ClubMember, ClubOwnerRecord, ClubRole,
        ClubRulesConfig,
    },
};

#[derive(Accounts)]
#[instruction(club_id: [u8; 32])]
pub struct CreateClub<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [CLUB_RULES_CONFIG_SEED], bump = club_rules.bump)]
    pub club_rules: Account<'info, ClubRulesConfig>,
    #[account(init_if_needed, payer = owner, space = 8 + ClubOwnerRecord::INIT_SPACE,
        seeds = [CLUB_OWNER_SEED, owner.key().as_ref()], bump)]
    pub owner_record: Account<'info, ClubOwnerRecord>,
    #[account(init, payer = owner, space = 8 + Club::INIT_SPACE,
        seeds = [CLUB_SEED, club_id.as_ref()], bump)]
    pub club: Account<'info, Club>,
    #[account(init, payer = owner, space = 8 + ClubMember::INIT_SPACE,
        seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), owner.key().as_ref()], bump)]
    pub owner_member: Account<'info, ClubMember>,
    pub system_program: Program<'info, System>,
}

/// Club admin acting on club-wide settings.
#[derive(Accounts)]
pub struct ManageClub<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub club: Account<'info, Club>,
    #[account(seeds = [CLUB_MEMBER_SEED, club.key().as_ref(), admin.key().as_ref()],
        bump = admin_member.bump,
        constraint = admin_member.role == ClubRole::Admin @ club::UnauthorizedClubAdmin)]
    pub admin_member: Account<'info, ClubMember>,
}

/// Validates a display name without trimming or rewriting it.
pub(crate) fn validate_club_name(name: &str) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= CLUB_NAME_MAX_LENGTH && name.trim() == name,
        club::InvalidClubName
    );
    Ok(())
}

/// Creates a club owned by the signer.
///
/// # Inputs
/// Paying owner, new club and owner-membership PDAs; a unique id and display name.
/// # Errors
/// Invalid name, an id already in use, the owner already owning the maximum
/// number of clubs, missing club rules or insufficient rent.
/// # Returns
/// A club of the chosen type with one admin member (the owner) and the
/// admins-only market policy; the owner's record counts it.
pub fn handle_create_club(
    ctx: Context<CreateClub>,
    club_id: [u8; 32],
    name: String,
    kind: ClubKind,
) -> Result<()> {
    validate_club_name(&name)?;
    let max = ctx.accounts.club_rules.max_owned_clubs;
    let bump = ctx.bumps.owner_record;
    ctx.accounts
        .owner_record
        .take(ctx.accounts.owner.key(), bump, max)?;
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let club_key = ctx.accounts.club.key();

    ctx.accounts.club.set_inner(Club {
        club_id,
        owner,
        pending_owner: None,
        name,
        market_policy: ClubMarketPolicy::AdminsOnly,
        member_count: 1,
        admin_count: 1,
        created_at: now,
        bump: ctx.bumps.club,
        kind,
        deposit_asset: ClubDepositAsset::None,
        deposit_amount: 0,
        live_markets: 0,
        live_markets_ready: true,
        closed: false,
        reserved: [0; 81],
    });
    ctx.accounts.owner_member.set_inner(ClubMember {
        club: club_key,
        wallet: owner,
        role: ClubRole::Admin,
        joined_at: now,
        bump: ctx.bumps.owner_member,
    });
    Ok(())
}

/// Chooses whether only admins or every member may create club markets.
///
/// # Inputs
/// A current club admin and the replacement policy.
/// # Errors
/// Signer is not a current admin of this club.
/// # Returns
/// `Ok(())` with the policy stored; existing markets are unaffected.
pub fn handle_set_club_market_policy(
    ctx: Context<ManageClub>,
    policy: ClubMarketPolicy,
) -> Result<()> {
    ctx.accounts.club.require_open()?;
    ctx.accounts.club.market_policy = policy;
    Ok(())
}
