//! Creates and updates presentation metadata without changing market state.
//!
//! Any active protocol administrator may manage labels. `MarketKind` is only
//! accepted during initialization, which makes classification immutable. The
//! prediction variant is rejected by this spot initializer: prediction drafts
//! create their own metadata alongside the single-collateral market accounts.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        ADMIN_SEED, MARKET_DISPLAY_NAME_MAX_LENGTH, MARKET_METADATA_SEED, MARKET_SYMBOL_MAX_LENGTH,
    },
    errors::{admin, market, metadata},
    events::{
        MarketMetadataClosedEvent, MarketMetadataInitializedEvent, MarketMetadataUpdatedEvent,
    },
    state::{AdminRecord, AdminStatus, Market, MarketKind, MarketMetadata, MarketStatus},
};

#[derive(Accounts)]
pub struct InitializeMarketMetadata<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
        has_one = authority @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled
    )]
    pub admin_record: Account<'info, AdminRecord>,

    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = authority,
        space = 8 + MarketMetadata::INIT_SPACE,
        seeds = [MARKET_METADATA_SEED, market.key().as_ref()],
        bump
    )]
    pub market_metadata: Account<'info, MarketMetadata>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateMarketMetadata<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [ADMIN_SEED, authority.key().as_ref()],
        bump = admin_record.bump,
        has_one = authority @ admin::UnauthorizedAdmin,
        constraint = admin_record.status == AdminStatus::Active @ admin::AdminDisabled
    )]
    pub admin_record: Account<'info, AdminRecord>,

    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [MARKET_METADATA_SEED, market.key().as_ref()],
        bump = market_metadata.bump,
        has_one = market @ metadata::MarketMetadataMismatch
    )]
    pub market_metadata: Account<'info, MarketMetadata>,
}

#[derive(Accounts)]
pub struct CloseMarketMetadata<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        has_one = authority @ market::Unauthorized,
        constraint = market.status == MarketStatus::Paused @ market::MarketMustBePaused
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        close = authority,
        seeds = [MARKET_METADATA_SEED, market.key().as_ref()],
        bump = market_metadata.bump,
        has_one = market @ metadata::MarketMetadataMismatch
    )]
    pub market_metadata: Account<'info, MarketMetadata>,
}

/// Attaches bounded display labels and an immutable kind to an existing spot market.
///
/// Any active protocol admin may pay for this PDA; market ownership alone is
/// insufficient. Prediction classification is reserved for the prediction-market
/// initializer, so display metadata cannot turn a spot account into that model.
///
/// # Inputs
/// `ctx`: active admin, spot market and new metadata; base/quote symbols, display name and
/// immutable `kind`.
///
/// # Errors
/// Invalid labels, Prediction kind, inactive/unauthorized admin or duplicate/misbound metadata.
///
/// # Returns
/// `Ok(())` with stored labels/kind and a creation event; economic fields do not change.
pub fn handle_initialize_market_metadata(
    ctx: Context<InitializeMarketMetadata>,
    base_symbol: String,
    quote_symbol: String,
    display_name: String,
    kind: MarketKind,
) -> Result<()> {
    validate_labels(&base_symbol, &quote_symbol, &display_name)?;
    require!(
        kind != MarketKind::Prediction,
        metadata::PredictionMarketUnavailable
    );

    let market_metadata = &mut ctx.accounts.market_metadata;
    market_metadata.market = ctx.accounts.market.key();
    market_metadata.base_symbol = base_symbol.clone();
    market_metadata.quote_symbol = quote_symbol.clone();
    market_metadata.display_name = display_name.clone();
    market_metadata.kind = kind;
    market_metadata.bump = ctx.bumps.market_metadata;

    emit!(MarketMetadataInitializedEvent {
        metadata: market_metadata.key(),
        market: market_metadata.market,
        authority: ctx.accounts.authority.key(),
        base_symbol,
        quote_symbol,
        display_name,
        kind,
    });

    Ok(())
}

/// Replaces display labels without changing mints, prices, balances or classification.
///
/// The context requires a current active admin and metadata bound to this spot
/// market. There is deliberately no `kind` argument: updating a name must not
/// change the market's economic rules or account layout.
///
/// # Inputs
/// `ctx`: active admin, spot market and bound metadata; replacement symbols and display name.
///
/// # Errors
/// Invalid labels, inactive/unauthorized admin or incorrect metadata binding.
///
/// # Returns
/// `Ok(())` after replacing labels and emitting an update; kind and token mints remain unchanged.
pub fn handle_update_market_metadata(
    ctx: Context<UpdateMarketMetadata>,
    base_symbol: String,
    quote_symbol: String,
    display_name: String,
) -> Result<()> {
    validate_labels(&base_symbol, &quote_symbol, &display_name)?;

    let market_metadata = &mut ctx.accounts.market_metadata;
    market_metadata.base_symbol = base_symbol.clone();
    market_metadata.quote_symbol = quote_symbol.clone();
    market_metadata.display_name = display_name.clone();

    emit!(MarketMetadataUpdatedEvent {
        metadata: market_metadata.key(),
        market: market_metadata.market,
        authority: ctx.accounts.authority.key(),
        base_symbol,
        quote_symbol,
        display_name,
    });

    Ok(())
}

/// Emits the metadata closure event before Anchor returns rent to the authority.
///
/// Closure requires the stored spot-market authority and Paused status. This
/// deletes display metadata only; vaults, trader balances and the market remain
/// until their separate shutdown requirements are met.
///
/// # Inputs
/// `ctx`: stored authority signer, Paused market and its metadata PDA.
///
/// # Errors
/// Wrong authority, non-Paused market or incorrect metadata binding.
///
/// # Returns
/// `Ok(())` and an event; Anchor returns metadata rent without closing vaults or market.
pub fn handle_close_market_metadata(ctx: Context<CloseMarketMetadata>) -> Result<()> {
    emit!(MarketMetadataClosedEvent {
        metadata: ctx.accounts.market_metadata.key(),
        market: ctx.accounts.market.key(),
        authority: ctx.accounts.authority.key(),
        kind: ctx.accounts.market_metadata.kind,
    });

    Ok(())
}

/// Restrict labels to a predictable ASCII subset so byte limits and rendered
/// lengths agree across Rust, TypeScript, wallets, and indexers.
///
/// # Inputs
/// Borrowed base/quote symbols and display name; limits count UTF-8 bytes.
///
/// # Errors
/// `InvalidMarketSymbol` or `InvalidMarketDisplayName` for size, character or edge-whitespace
/// violations.
///
/// # Returns
/// `Ok(())` for valid labels; inputs are neither trimmed nor rewritten.
pub(crate) fn validate_labels(
    base_symbol: &str,
    quote_symbol: &str,
    display_name: &str,
) -> Result<()> {
    require!(valid_symbol(base_symbol), metadata::InvalidMarketSymbol);
    require!(valid_symbol(quote_symbol), metadata::InvalidMarketSymbol);
    require!(
        !display_name.is_empty()
            && display_name.len() <= MARKET_DISPLAY_NAME_MAX_LENGTH
            && display_name.trim() == display_name
            && display_name
                .bytes()
                .all(|byte| byte == b' ' || byte.is_ascii_graphic()),
        metadata::InvalidMarketDisplayName
    );

    Ok(())
}

/// Accepts nonempty ASCII symbols within the byte bound, without spaces or markup.
/// Examples: `SOL`, `tUSDT` and `YES-NO` pass; `SOL / USD` does not.
///
/// # Inputs
/// `symbol`: candidate UTF-8 text.
///
/// # Errors
/// None; invalid text is represented by `false`.
///
/// # Returns
/// `true` for nonempty bounded ASCII letters/digits/dot/hyphen/underscore; otherwise `false`.
fn valid_symbol(symbol: &str) -> bool {
    !symbol.is_empty()
        && symbol.len() <= MARKET_SYMBOL_MAX_LENGTH
        && symbol
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_expected_market_labels() {
        assert!(validate_labels("tSOL", "tUSDC", "Tidebook SOL / USDC").is_ok());
    }

    #[test]
    fn rejects_empty_or_unsafe_symbols() {
        assert!(validate_labels("", "USDC", "SOL / USDC").is_err());
        assert!(validate_labels("SOL/USDC", "USDC", "SOL / USDC").is_err());
        assert!(validate_labels("SOL⚡", "USDC", "SOL / USDC").is_err());
    }

    #[test]
    fn rejects_invalid_display_names() {
        assert!(validate_labels("SOL", "USDC", "").is_err());
        assert!(validate_labels("SOL", "USDC", " outer whitespace ").is_err());
        assert!(validate_labels("SOL", "USDC", "line\nbreak").is_err());
    }
}
