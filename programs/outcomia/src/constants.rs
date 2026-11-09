//! Shared PDA namespaces and numeric boundaries used by the program and tests.

use anchor_lang::prelude::*;

/// Namespace for markets keyed by their ordered base/quote mint pair.
#[constant]
pub const MARKET_SEED: &[u8] = b"market";

/// Prediction market keyed by a program-wide 32-byte identifier.
#[constant]
pub const PREDICTION_MARKET_SEED: &[u8] = b"prediction_market";

/// Internal prediction ledger: [namespace, prediction market, owner].
#[constant]
pub const PREDICTION_POSITION_SEED: &[u8] = b"prediction_position";

/// Index root: [namespace, prediction market].
#[constant]
pub const PREDICTION_BOOK_SEED: &[u8] = b"prediction_book";

/// FIFO price level: [namespace, market, outcome, side, price_le].
#[constant]
pub const PREDICTION_PRICE_LEVEL_SEED: &[u8] = b"prediction_level";

/// Market-wide submission identity: [namespace, market, order_id_le].
#[constant]
pub const PREDICTION_ORDER_SEED: &[u8] = b"prediction_order";

/// Namespace for the human-readable metadata attached to one market.
///
/// PDA: ["market_metadata", market]
#[constant]
pub const MARKET_METADATA_SEED: &[u8] = b"market_metadata";

/// Maximum UTF-8 byte length accepted for base and quote symbols.
pub const MARKET_SYMBOL_MAX_LENGTH: usize = 16;

/// Maximum UTF-8 byte length accepted for a market display name.
pub const MARKET_DISPLAY_NAME_MAX_LENGTH: usize = 64;

/// Namespace for market-local orders keyed by their monotonic order ID.
#[constant]
pub const ORDER_SEED: &[u8] = b"order";

/// Inclusive raw-price boundary exposed to clients and future validation.
#[constant]
pub const MIN_PRICE: u64 = 1;

/// Largest representable raw integer price.
#[constant]
pub const MAX_PRICE: u64 = u64::MAX;

/// Largest representable raw base-asset quantity.
#[constant]
pub const MAX_QUANTITY: u64 = u64::MAX;

/// Singleton protocol-governance configuration.
#[constant]
pub const PROTOCOL_CONFIG_SEED: &[u8] = b"protocol_config";

/// Per-wallet administrator record namespace.
#[constant]
pub const ADMIN_SEED: &[u8] = b"admin";

/// Stateless PDA that owns both token vaults belonging to a market.
#[constant]
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault-authority";

/// Token vault namespace; the remaining seeds are the market and asset mint.
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

/// Namespace for one active market-side-price queue.
#[constant]
pub const PRICE_LEVEL_SEED: &[u8] = b"price_level";

/// Seed for the canonical balance account belonging to one trader in one market.
///
/// PDA:
/// ["trader_balance", market, trader]
#[constant]
pub const TRADER_BALANCE_SEED: &[u8] = b"trader_balance";

/// Namespace for one market's quote-denominated protocol-fee accumulator.
///
/// PDA:
/// ["market_fees", market]
#[constant]
pub const MARKET_FEES_SEED: &[u8] = b"market_fees";

/// Namespace for one market's explicitly configured test-token faucet.
#[constant]
pub const TEST_FAUCET_SEED: &[u8] = b"test_faucet";

/// Stateless PDA that owns the mint authority of faucet-enabled test mints.
#[constant]
pub const TEST_FAUCET_AUTHORITY_SEED: &[u8] = b"test_faucet_authority";

/// Global fungible ledger: [asset_balance, owner, mint].
#[constant]
pub const ASSET_BALANCE_SEED: &[u8] = b"asset_balance";
/// Shared custody: [asset_vault, mint].
#[constant]
pub const ASSET_VAULT_SEED: &[u8] = b"asset_vault";
/// Stateless signing authority: [asset_authority, mint].
#[constant]
pub const ASSET_AUTHORITY_SEED: &[u8] = b"asset_authority";
/// Independent execution root; legacy market queues remain recoverable.
#[constant]
pub const SHARED_BOOK_SEED: &[u8] = b"shared_book";
#[constant]
pub const SHARED_ORDER_SEED: &[u8] = b"shared_order";
#[constant]
pub const SHARED_LEVEL_SEED: &[u8] = b"shared_level";
