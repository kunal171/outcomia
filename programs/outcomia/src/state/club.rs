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

/// Whether a club may be listed publicly. Fixed at creation; the type sets
/// its member cap and its minimum security deposit.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ClubKind {
    Private,
    Public,
}

/// Token a club's security deposit is held in. Fixed by the first deposit.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ClubDepositAsset {
    /// No deposit yet. Zeroed reserved space decodes to this.
    None,
    /// The configured deposit mint (USDC; outcomia-tUSDC on devnet), held in
    /// the club's deposit vault.
    Usdc,
    /// Lamports held in the club account itself, above its rent.
    Sol,
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
    pub kind: ClubKind,
    /// Token of the security deposit; `None` until the first deposit.
    pub deposit_asset: ClubDepositAsset,
    /// Deposit balance in the asset's base units (token units or lamports).
    pub deposit_amount: u64,
    /// Club markets created and not yet settled. Closing a club needs zero.
    pub live_markets: u32,
    /// Whether `live_markets` is trustworthy. Clubs created before the counter
    /// existed stay `false` until the super-admin backfills it.
    pub live_markets_ready: bool,
    /// Closed by its owner: the deposit is refunded and nothing can join or
    /// change. The account stays so its id is never reused and existing member
    /// records can only be closed, never revived.
    pub closed: bool,
    /// Zeroed space for later club settings.
    pub reserved: [u8; 81],
}

/// Marks a club market as settled: finished, with its club fees withdrawn,
/// so it no longer counts against closing the club. It exists at most once.
///
/// PDA: ["club_market_settled", club_market]
#[account]
#[derive(InitSpace, Debug)]
pub struct ClubMarketSettlement {
    pub club_market: Pubkey,
    pub settled_at: i64,
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

/// Protocol-wide share of club-market taker fees paid to the club.
///
/// PDA: ["club_fee_config"]. Until the super-admin creates it, the share is zero.
#[account]
#[derive(InitSpace, Debug)]
pub struct ClubFeeConfig {
    /// Basis points of each club-market taker fee credited to the club.
    pub club_share_bps: u16,
    pub bump: u8,
}

/// Who may trade in a club market.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ClubMarketAccess {
    /// Placement, every fill and splitting require current membership.
    MembersOnly,
    /// Anyone may trade; the club curates and resolves.
    Public,
}

/// Club binding of a binary market created in the club namespace.
///
/// PDA: ["club_market", market]. The market itself lives at
/// ["club_prediction_market", market_id], which public instructions never derive.
#[account]
#[derive(InitSpace, Debug)]
pub struct ClubMarket {
    pub club: Pubkey,
    pub market: Pubkey,
    pub access: ClubMarketAccess,
    pub creator: Pubkey,
    /// Club share of taker fees, held in the global asset vault until withdrawn.
    pub accrued_club_fees: u64,
    pub bump: u8,
}

/// How a listed club admits members. Clubs without a listing stay private
/// (invite-only), exactly as before listings existed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ClubVisibility {
    /// Discoverable; wallets request membership and a club admin approves.
    Public,
    /// Discoverable; any wallet joins directly.
    Open,
}

/// Public listing of a club. It is discoverable, and admits requests or open
/// joins, only while a protocol admin has verified its current terms; any
/// change by the owner clears the verification.
///
/// PDA: ["club_listing", club]
#[account]
#[derive(InitSpace, Debug)]
pub struct ClubListing {
    pub club: Pubkey,
    pub visibility: ClubVisibility,
    #[max_len(32)]
    pub topic: String,
    #[max_len(280)]
    pub description: String,
    /// Protocol admin who verified the current terms, if any.
    pub verified_by: Option<Pubkey>,
    pub updated_at: i64,
    pub bump: u8,
}

/// A wallet's pending request to join a public club. The wallet pays its rent
/// and receives it back however the request closes.
///
/// PDA: ["club_join_request", club, wallet]
#[account]
#[derive(InitSpace, Debug)]
pub struct ClubJoinRequest {
    pub club: Pubkey,
    pub wallet: Pubkey,
    #[max_len(140)]
    pub note: String,
    pub expires_at: i64,
    pub bump: u8,
}

/// Platform limits for clubs, set by the super-admin.
///
/// PDA: ["club_rules_config"]. Club creation, joining and admin promotion
/// require it, so a limit can never be bypassed by omitting the account.
#[account]
#[derive(InitSpace, Debug)]
pub struct ClubRulesConfig {
    pub public_member_cap: u32,
    pub private_member_cap: u32,
    /// Clubs one wallet may own at a time, any mix of types.
    pub max_owned_clubs: u16,
    /// Admins per club, the owner included.
    pub max_club_admins: u16,
    pub bump: u8,
    /// Mint of USDC deposits. The default key means deposit rules are not set,
    /// and no club market can be created or opened.
    pub deposit_mint: Pubkey,
    pub deposit_mint_decimals: u8,
    /// Minimum deposit value in USD with 6 decimals ($100 = 100_000_000).
    pub private_min_deposit_usd: u64,
    pub public_min_deposit_usd: u64,
    /// SOL deposits must be worth this share of the minimum when paid (12_000 = 120%).
    pub sol_buffer_bps: u16,
    /// Pyth SOL/USD price feed id.
    pub sol_usd_feed_id: [u8; 32],
    /// Oldest accepted Pyth price, in seconds.
    pub max_price_age_seconds: u32,
    /// Widest accepted Pyth confidence band, in basis points of the price.
    pub max_price_conf_bps: u16,
    /// Zeroed space for later platform settings.
    pub reserved: [u8; 39],
}

impl ClubRulesConfig {
    pub fn member_cap(&self, kind: ClubKind) -> u32 {
        match kind {
            ClubKind::Public => self.public_member_cap,
            ClubKind::Private => self.private_member_cap,
        }
    }
    /// Minimum deposit value for a club type, in USD with 6 decimals.
    pub fn min_deposit_usd(&self, kind: ClubKind) -> u64 {
        match kind {
            ClubKind::Public => self.public_min_deposit_usd,
            ClubKind::Private => self.private_min_deposit_usd,
        }
    }
    pub fn deposits_configured(&self) -> bool {
        self.deposit_mint != Pubkey::default()
    }
}

/// How many clubs a wallet owns right now.
///
/// PDA: ["club_owner", wallet]
#[account]
#[derive(InitSpace, Debug)]
pub struct ClubOwnerRecord {
    pub wallet: Pubkey,
    pub owned: u16,
    pub bump: u8,
}

impl ClubOwnerRecord {
    /// Counts one more owned club, within `max`.
    pub(crate) fn take(&mut self, wallet: Pubkey, bump: u8, max: u16) -> Result<()> {
        require!(self.owned < max, crate::errors::club::ClubOwnerLimitReached);
        self.wallet = wallet;
        self.bump = bump;
        self.owned += 1;
        Ok(())
    }
    /// Counts one fewer owned club.
    pub(crate) fn give_up(&mut self) -> Result<()> {
        self.owned = self
            .owned
            .checked_sub(1)
            .ok_or(crate::errors::club::ClubCounterMismatch)?;
        Ok(())
    }
}
