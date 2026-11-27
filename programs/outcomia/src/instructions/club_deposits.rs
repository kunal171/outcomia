//! Club security deposits (club rules milestone 2a).
//!
//! A club holds one deposit, in USDC or SOL, chosen by its first deposit:
//! - USDC sits in the club's deposit vault, a token account whose authority is
//!   the club account;
//! - SOL sits in the club account itself, above its rent.
//!
//! Every deposit must leave the club at or above its payment minimum: the
//! dollar minimum in USDC, or the dollar minimum times the SOL buffer at the
//! current Pyth price. A club below its dollar minimum cannot create or open
//! markets; its existing markets keep trading and resolving.
//!
//! SOL is valued with any fully verified Pyth `PriceUpdateV2` account for the
//! configured feed: Pyth's shared push-feed account, or one the caller posted
//! in the same transaction.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer as sol_transfer, Transfer as SolTransfer};
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::{
    constants::*,
    errors::{admin, club},
    state::*,
};

/// Lamports per SOL, as a power of ten.
const SOL_DECIMALS: i32 = 9;

#[derive(Accounts)]
pub struct SetClubDepositRules<'info> {
    pub super_admin: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump,
        has_one = super_admin @ admin::UnauthorizedSuperAdmin)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [CLUB_RULES_CONFIG_SEED], bump = club_rules.bump)]
    pub club_rules: Account<'info, ClubRulesConfig>,
    pub deposit_mint: Account<'info, Mint>,
}

/// Deposit-rule values set by the super-admin.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ClubDepositRules {
    pub private_min_deposit_usd: u64,
    pub public_min_deposit_usd: u64,
    pub sol_buffer_bps: u16,
    pub sol_usd_feed_id: [u8; 32],
    pub max_price_age_seconds: u32,
    pub max_price_conf_bps: u16,
}

/// Sets the deposit mint and every deposit rule.
///
/// # Inputs
/// The super-admin, the existing club rules, the USDC mint and the rules.
/// # Errors
/// Not the super-admin; club rules missing; a minimum is zero; the SOL buffer
/// is outside 100-300%; the price age is outside 1-300 seconds; the confidence
/// limit is above 10%; or the feed id is zero.
/// # Returns
/// `Ok(())`. New values apply to later deposits and market checks; deposits
/// already held are unchanged.
pub fn handle_set_club_deposit_rules(
    ctx: Context<SetClubDepositRules>,
    rules: ClubDepositRules,
) -> Result<()> {
    require!(
        rules.private_min_deposit_usd > 0
            && rules.public_min_deposit_usd > 0
            && (MIN_SOL_BUFFER_BPS..=MAX_SOL_BUFFER_BPS).contains(&rules.sol_buffer_bps)
            && (1..=MAX_PRICE_AGE_LIMIT_SECONDS).contains(&rules.max_price_age_seconds)
            && rules.max_price_conf_bps <= MAX_PRICE_CONF_LIMIT_BPS
            && rules.sol_usd_feed_id != [0; 32],
        club::InvalidClubDepositRules
    );
    let config = &mut ctx.accounts.club_rules;
    config.deposit_mint = ctx.accounts.deposit_mint.key();
    config.deposit_mint_decimals = ctx.accounts.deposit_mint.decimals;
    config.private_min_deposit_usd = rules.private_min_deposit_usd;
    config.public_min_deposit_usd = rules.public_min_deposit_usd;
    config.sol_buffer_bps = rules.sol_buffer_bps;
    config.sol_usd_feed_id = rules.sol_usd_feed_id;
    config.max_price_age_seconds = rules.max_price_age_seconds;
    config.max_price_conf_bps = rules.max_price_conf_bps;
    Ok(())
}

#[derive(Accounts)]
pub struct DepositClubUsdc<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ club::UnauthorizedClubOwner)]
    pub club: Box<Account<'info, Club>>,
    #[account(seeds = [CLUB_RULES_CONFIG_SEED], bump = club_rules.bump)]
    pub club_rules: Box<Account<'info, ClubRulesConfig>>,
    #[account(address = club_rules.deposit_mint @ club::ClubDepositRulesNotSet)]
    pub deposit_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = deposit_mint, token::authority = owner)]
    pub owner_token: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = owner,
        seeds = [CLUB_DEPOSIT_VAULT_SEED, club.key().as_ref()], bump,
        token::mint = deposit_mint, token::authority = club)]
    pub deposit_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Pays or tops up a club's deposit in USDC.
///
/// # Inputs
/// The club owner, the club, its rules, the USDC mint, the owner's token
/// account, the club's deposit vault (created on first use) and an amount.
/// # Errors
/// Not the owner; deposit rules not set; a zero amount; the club already holds
/// SOL; or the balance after the deposit is below the club type's minimum.
/// # Returns
/// `Ok(())` with the tokens in the vault and the club's balance increased.
pub fn handle_deposit_club_usdc(ctx: Context<DepositClubUsdc>, amount: u64) -> Result<()> {
    let rules = &ctx.accounts.club_rules;
    require!(rules.deposits_configured(), club::ClubDepositRulesNotSet);
    require!(amount > 0, club::ClubDepositTooLow);
    let club = &ctx.accounts.club;
    require!(
        matches!(
            club.deposit_asset,
            ClubDepositAsset::None | ClubDepositAsset::Usdc
        ),
        club::ClubDepositAssetMismatch
    );
    let balance = club
        .deposit_amount
        .checked_add(amount)
        .ok_or(club::ClubDepositOverflow)?;
    let minimum = usd_to_token_units(
        rules.min_deposit_usd(club.kind),
        rules.deposit_mint_decimals,
    )?;
    require!(balance >= minimum, club::ClubDepositTooLow);

    transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.owner_token.to_account_info(),
                to: ctx.accounts.deposit_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;
    let club = &mut ctx.accounts.club;
    club.deposit_asset = ClubDepositAsset::Usdc;
    club.deposit_amount = balance;
    Ok(())
}

#[derive(Accounts)]
pub struct DepositClubSol<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ club::UnauthorizedClubOwner)]
    pub club: Box<Account<'info, Club>>,
    #[account(seeds = [CLUB_RULES_CONFIG_SEED], bump = club_rules.bump)]
    pub club_rules: Box<Account<'info, ClubRulesConfig>>,
    pub price_update: Box<Account<'info, PriceUpdateV2>>,
    pub system_program: Program<'info, System>,
}

/// Pays or tops up a club's deposit in SOL.
///
/// # Inputs
/// The club owner, the club, its rules, a fresh Pyth SOL/USD price and an
/// amount in lamports.
/// # Errors
/// Not the owner; deposit rules not set; a zero amount; the club already holds
/// USDC; an unusable price; or the balance after the deposit is worth less than
/// the minimum times the SOL buffer.
/// # Returns
/// `Ok(())` with the lamports in the club account and its balance increased.
pub fn handle_deposit_club_sol(ctx: Context<DepositClubSol>, lamports: u64) -> Result<()> {
    let rules = &ctx.accounts.club_rules;
    require!(rules.deposits_configured(), club::ClubDepositRulesNotSet);
    require!(lamports > 0, club::ClubDepositTooLow);
    let club = &ctx.accounts.club;
    require!(
        matches!(
            club.deposit_asset,
            ClubDepositAsset::None | ClubDepositAsset::Sol
        ),
        club::ClubDepositAssetMismatch
    );
    let balance = club
        .deposit_amount
        .checked_add(lamports)
        .ok_or(club::ClubDepositOverflow)?;
    let price = read_sol_usd_price(&ctx.accounts.price_update, rules)?;
    let value = lamports_to_usd(balance, &price)?;
    let required = (rules.min_deposit_usd(club.kind) as u128)
        .checked_mul(rules.sol_buffer_bps as u128)
        .ok_or(club::ClubDepositOverflow)?;
    require!(
        value.checked_mul(10_000).ok_or(club::ClubDepositOverflow)? >= required,
        club::ClubDepositTooLow
    );

    sol_transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            SolTransfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.club.to_account_info(),
            },
        ),
        lamports,
    )?;
    let club = &mut ctx.accounts.club;
    club.deposit_asset = ClubDepositAsset::Sol;
    club.deposit_amount = balance;
    Ok(())
}

#[derive(Accounts)]
pub struct SetClubLiveMarkets<'info> {
    pub super_admin: Signer<'info>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump,
        has_one = super_admin @ admin::UnauthorizedSuperAdmin)]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub club: Account<'info, Club>,
}

/// Backfills the unsettled-market count of a club created before the counter.
///
/// # Inputs
/// The super-admin, the club and the number of its club markets that exist
/// today. Every club market counts until it is settled.
/// # Errors
/// Not the super-admin, or the count was already set (every club created
/// after the counter, and every club backfilled once).
/// # Returns
/// `Ok(())` with the count stored and marked ready.
pub fn handle_set_club_live_markets(ctx: Context<SetClubLiveMarkets>, count: u32) -> Result<()> {
    let club = &mut ctx.accounts.club;
    require!(!club.live_markets_ready, club::ClubMarketCountAlreadySet);
    club.live_markets = count;
    club.live_markets_ready = true;
    Ok(())
}

/// Requires a club to hold at least its dollar minimum before a market is
/// created or opened.
///
/// # Errors
/// Deposit rules not set; no deposit or a balance below the minimum; or, for a
/// SOL deposit, a missing or unusable price update.
pub(crate) fn require_club_funded(
    club: &Club,
    rules: &ClubRulesConfig,
    price_update: Option<&PriceUpdateV2>,
) -> Result<()> {
    require!(rules.deposits_configured(), club::ClubDepositRulesNotSet);
    let minimum = rules.min_deposit_usd(club.kind);
    let funded = match club.deposit_asset {
        ClubDepositAsset::None => false,
        ClubDepositAsset::Usdc => {
            club.deposit_amount >= usd_to_token_units(minimum, rules.deposit_mint_decimals)?
        }
        ClubDepositAsset::Sol => {
            let update = price_update.ok_or(club::ClubPriceUpdateRequired)?;
            let price = read_sol_usd_price(update, rules)?;
            lamports_to_usd(club.deposit_amount, &price)? >= minimum as u128
        }
    };
    require!(funded, club::ClubDepositBelowMinimum);
    Ok(())
}

/// SOL/USD price as an integer mantissa and a power-of-ten exponent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct UsdPrice {
    pub price: u64,
    pub exponent: i32,
}

/// Reads a fully verified, fresh, positive SOL/USD price within the
/// configured confidence band.
fn read_sol_usd_price(update: &PriceUpdateV2, rules: &ClubRulesConfig) -> Result<UsdPrice> {
    let price = update
        .get_price_no_older_than(
            &Clock::get()?,
            rules.max_price_age_seconds as u64,
            &rules.sol_usd_feed_id,
        )
        .map_err(|_| error!(club::InvalidPriceUpdate))?;
    require!(price.price > 0, club::InvalidPriceUpdate);
    let mantissa = price.price as u64;
    require!(
        (price.conf as u128) * 10_000 <= (mantissa as u128) * rules.max_price_conf_bps as u128,
        club::PriceConfidenceTooWide
    );
    Ok(UsdPrice {
        price: mantissa,
        exponent: price.exponent,
    })
}

/// Token base units needed for a USD amount (6 decimals), rounded up.
pub(crate) fn usd_to_token_units(usd: u64, decimals: u8) -> Result<u64> {
    let usd = usd as u128;
    let units = if decimals as u32 >= USD_DECIMALS {
        usd.checked_mul(10u128.pow(decimals as u32 - USD_DECIMALS))
    } else {
        let divisor = 10u128.pow(USD_DECIMALS - decimals as u32);
        Some(usd.div_ceil(divisor))
    }
    .ok_or(club::ClubDepositOverflow)?;
    u64::try_from(units).map_err(|_| error!(club::ClubDepositOverflow))
}

/// USD value (6 decimals) of a lamport amount at `price`, rounded down.
pub(crate) fn lamports_to_usd(lamports: u64, price: &UsdPrice) -> Result<u128> {
    // value = lamports / 10^9 * price * 10^exponent * 10^6
    let product = (lamports as u128)
        .checked_mul(price.price as u128)
        .ok_or(club::ClubDepositOverflow)?;
    let shift = price.exponent + USD_DECIMALS as i32 - SOL_DECIMALS;
    let scale = |power: i32| {
        10u128
            .checked_pow(power.unsigned_abs())
            .ok_or(error!(club::ClubDepositOverflow))
    };
    if shift >= 0 {
        product
            .checked_mul(scale(shift)?)
            .ok_or(error!(club::ClubDepositOverflow))
    } else {
        Ok(product / scale(shift)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usd_converts_to_token_units() {
        assert_eq!(usd_to_token_units(100_000_000, 6).unwrap(), 100_000_000);
        assert_eq!(usd_to_token_units(100_000_000, 9).unwrap(), 100_000_000_000);
        assert_eq!(usd_to_token_units(100_000_001, 2).unwrap(), 10_001);
    }

    #[test]
    fn lamports_value_in_usd() {
        // $150 per SOL with exponent -8.
        let price = UsdPrice {
            price: 15_000_000_000,
            exponent: -8,
        };
        assert_eq!(lamports_to_usd(1_000_000_000, &price).unwrap(), 150_000_000);
        assert_eq!(lamports_to_usd(1, &price).unwrap(), 0);
        // Positive exponent.
        let coarse = UsdPrice {
            price: 15,
            exponent: 1,
        };
        assert_eq!(
            lamports_to_usd(1_000_000_000, &coarse).unwrap(),
            150_000_000
        );
        assert!(lamports_to_usd(
            u64::MAX,
            &UsdPrice {
                price: u64::MAX,
                exponent: 30
            }
        )
        .is_err());
    }
}
