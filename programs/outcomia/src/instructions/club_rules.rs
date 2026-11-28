//! Platform club rules (super-admin) and the one-time upgrade of clubs
//! created before club types existed.
//!
//! Limits are enforced where they apply: creation (owned clubs), every join
//! path (member caps), promotion and ownership transfer (admins, owned clubs).
//! Lowering a limit never removes anyone; it only blocks further growth.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::{
    constants::*,
    errors::{admin, club},
    state::*,
};

#[derive(Accounts)]
pub struct SetClubRules<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump,
        has_one = super_admin @ admin::UnauthorizedSuperAdmin)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(init_if_needed, payer = super_admin, space = 8 + ClubRulesConfig::INIT_SPACE,
        seeds = [CLUB_RULES_CONFIG_SEED], bump)]
    pub club_rules: Account<'info, ClubRulesConfig>,
    pub system_program: Program<'info, System>,
}

/// Creates or updates the platform club limits.
///
/// # Inputs
/// The super-admin (paying rent on first use) and every limit, each at least 1.
/// # Errors
/// Signer is not the super-admin, or a limit is zero.
/// # Returns
/// `Ok(())` with the limits stored; reserved space is preserved.
pub fn handle_set_club_rules(
    ctx: Context<SetClubRules>,
    public_member_cap: u32,
    private_member_cap: u32,
    max_owned_clubs: u16,
    max_club_admins: u16,
) -> Result<()> {
    require!(
        public_member_cap >= 1
            && private_member_cap >= 1
            && max_owned_clubs >= 1
            && max_club_admins >= 1,
        club::InvalidClubRules
    );
    let rules = &mut ctx.accounts.club_rules;
    rules.public_member_cap = public_member_cap;
    rules.private_member_cap = private_member_cap;
    rules.max_owned_clubs = max_owned_clubs;
    rules.max_club_admins = max_club_admins;
    rules.bump = ctx.bumps.club_rules;
    Ok(())
}

/// Club layout before club types: no `kind` and no reserved space.
#[derive(AnchorDeserialize)]
struct LegacyClub {
    club_id: [u8; 32],
    owner: Pubkey,
    pending_owner: Option<Pubkey>,
    name: String,
    market_policy: ClubMarketPolicy,
    member_count: u32,
    admin_count: u32,
    created_at: i64,
    bump: u8,
}

#[derive(Accounts)]
#[instruction(kind: ClubKind, owner: Pubkey)]
pub struct MigrateClub<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump,
        has_one = super_admin @ admin::UnauthorizedSuperAdmin)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    /// CHECK: A legacy club: program-owned, Club discriminator, legacy size and
    /// its own PDA. Verified in the handler before it is rewritten.
    #[account(mut, owner = crate::ID)]
    pub club: UncheckedAccount<'info>,
    /// CHECK: The club's listing PDA. A private club must not have one.
    #[account(seeds = [CLUB_LISTING_SEED, club.key().as_ref()], bump)]
    pub listing: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = super_admin, space = 8 + ClubOwnerRecord::INIT_SPACE,
        seeds = [CLUB_OWNER_SEED, owner.as_ref()], bump)]
    pub owner_record: Account<'info, ClubOwnerRecord>,
    pub system_program: Program<'info, System>,
}

/// Upgrades a club created before club types to the current layout.
///
/// # Inputs
/// The super-admin (paying the extra rent), the club, its listing PDA, the
/// club type and the club's current owner.
/// # Errors
/// Not the super-admin; the account is not a legacy club; `owner` is not the
/// stored owner; or `Private` was chosen while the club has a listing.
/// # Returns
/// `Ok(())` with the club rewritten (type set, reserved space zeroed) and the
/// owner's record counting it. Existing owners are not held to the owned-club
/// limit here; they cannot create more clubs while over it.
pub fn handle_migrate_club(ctx: Context<MigrateClub>, kind: ClubKind, owner: Pubkey) -> Result<()> {
    let info = ctx.accounts.club.to_account_info();
    let new_len = 8 + Club::INIT_SPACE;
    let legacy = {
        let data = info.try_borrow_data()?;
        require!(
            data.len() < new_len && data.len() >= 8 && data[..8] == *Club::DISCRIMINATOR,
            club::ClubMigrationNotNeeded
        );
        LegacyClub::deserialize(&mut &data[8..])?
    };
    require_keys_eq!(legacy.owner, owner, club::InvalidClubMember);
    let expected = Pubkey::create_program_address(
        &[CLUB_SEED, legacy.club_id.as_ref(), &[legacy.bump]],
        &crate::ID,
    )
    .map_err(|_| error!(club::ClubMigrationNotNeeded))?;
    require_keys_eq!(expected, info.key(), club::ClubMigrationNotNeeded);
    if kind == ClubKind::Private {
        require!(
            ctx.accounts.listing.data_is_empty(),
            club::PrivateClubCannotList
        );
    }

    let needed = Rent::get()?
        .minimum_balance(new_len)
        .saturating_sub(info.lamports());
    if needed > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.super_admin.to_account_info(),
                    to: info.clone(),
                },
            ),
            needed,
        )?;
    }
    info.resize(new_len)?;
    let club = Club {
        club_id: legacy.club_id,
        owner: legacy.owner,
        pending_owner: legacy.pending_owner,
        name: legacy.name,
        market_policy: legacy.market_policy,
        member_count: legacy.member_count,
        admin_count: legacy.admin_count,
        created_at: legacy.created_at,
        bump: legacy.bump,
        kind,
        deposit_asset: ClubDepositAsset::None,
        deposit_amount: 0,
        live_markets: 0,
        // Its existing markets are uncounted until the super-admin backfills them.
        live_markets_ready: false,
        reserved: [0; 82],
    };
    let mut data = info.try_borrow_mut_data()?;
    let mut cursor: &mut [u8] = &mut data;
    club.try_serialize(&mut cursor)?;

    let record = &mut ctx.accounts.owner_record;
    record.wallet = owner;
    record.bump = ctx.bumps.owner_record;
    record.owned = record
        .owned
        .checked_add(1)
        .ok_or(club::ClubCounterMismatch)?;
    Ok(())
}
