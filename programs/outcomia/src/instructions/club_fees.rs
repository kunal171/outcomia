//! Protocol-wide club fee share, set by the super-admin.
//!
//! Club markets charge the normal taker fee; this share of it is credited to
//! the market's club instead of the protocol. Changing the share affects only
//! later fills and never touches fees already accrued.

use anchor_lang::prelude::*;

use crate::{
    constants::{CLUB_FEE_CONFIG_SEED, PROTOCOL_CONFIG_SEED},
    errors::{admin, club},
    fees::MAX_CLUB_FEE_SHARE_BPS,
    state::{ClubFeeConfig, ProtocolConfig},
};

#[derive(Accounts)]
pub struct SetClubFeeShare<'info> {
    #[account(mut)]
    pub super_admin: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump,
        has_one = super_admin @ admin::UnauthorizedSuperAdmin)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(init_if_needed, payer = super_admin, space = 8 + ClubFeeConfig::INIT_SPACE,
        seeds = [CLUB_FEE_CONFIG_SEED], bump)]
    pub club_fee_config: Account<'info, ClubFeeConfig>,
    pub system_program: Program<'info, System>,
}

/// Creates or updates the club share of club-market taker fees.
///
/// # Inputs
/// The super-admin (paying rent on first use) and the share in basis points of the taker fee.
/// # Errors
/// `ClubFeeShareTooHigh` above 5,000 bps, or a signer other than the stored super-admin.
/// # Returns
/// `Ok(())` with the share stored for subsequent club fills.
pub fn handle_set_club_fee_share(ctx: Context<SetClubFeeShare>, club_share_bps: u16) -> Result<()> {
    require!(
        club_share_bps <= MAX_CLUB_FEE_SHARE_BPS,
        club::ClubFeeShareTooHigh
    );
    ctx.accounts.club_fee_config.set_inner(ClubFeeConfig {
        club_share_bps,
        bump: ctx.bumps.club_fee_config,
    });
    Ok(())
}
