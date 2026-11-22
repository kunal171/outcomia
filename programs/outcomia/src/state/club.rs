//! Club membership accounts.
//!
//! A club is a self-governed group of wallets. Its roles are independent of
//! protocol administration: no club role grants protocol-admin authority and no
//! protocol role grants club authority.

use anchor_lang::prelude::*;

/// Who may create markets inside a club.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ClubMarketPolicy {
    AdminsOnly,
    AnyMember,
}

/// Role of an active member. The owner always holds `Admin`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ClubRole {
    Member,
    Admin,
}

/// One club, keyed by a creator-chosen 32-byte identifier.
///
/// PDA: ["club", club_id]
#[account]
#[derive(InitSpace, Debug)]
pub struct Club {
    pub club_id: [u8; 32],
    pub owner: Pubkey,
    /// Member nominated by the owner; becomes owner only by accepting.
    pub pending_owner: Option<Pubkey>,
    #[max_len(64)]
    pub name: String,
    pub market_policy: ClubMarketPolicy,
    /// Active `ClubMember` records, the owner's included.
    pub member_count: u32,
    /// Active members holding `ClubRole::Admin`, the owner's included.
    pub admin_count: u32,
    pub created_at: i64,
    pub bump: u8,
}

/// Proof of active membership. It exists only while the wallet is a member;
/// leaving or removal closes it.
///
/// PDA: ["club_member", club, wallet]
#[account]
#[derive(InitSpace, Debug)]
pub struct ClubMember {
    pub club: Pubkey,
    pub wallet: Pubkey,
    pub role: ClubRole,
    pub joined_at: i64,
    pub bump: u8,
}

/// Pending invitation. The inviter pays its rent and receives it back when the
/// invitation is accepted, revoked, declined or closed after expiry.
///
/// PDA: ["club_invite", club, wallet]
#[account]
#[derive(InitSpace, Debug)]
pub struct ClubInvite {
    pub club: Pubkey,
    pub wallet: Pubkey,
    pub inviter: Pubkey,
    pub expires_at: i64,
    pub bump: u8,
}
