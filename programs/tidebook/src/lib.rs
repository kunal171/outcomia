//! Tidebook's on-chain Anchor program entrypoints.
//!
//! The crate delegates account validation and state transitions to focused
//! instruction modules while exposing a stable interface for generated clients.

pub mod constants;
pub mod errors;
pub mod events;
pub mod fees;
pub mod instructions;
pub mod matching;
pub mod pda;
pub mod prediction_config;
mod prediction_orders;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use events::*;
pub use fees::*;
pub use instructions::*;
pub use matching::*;
pub use pda::*;
pub use state::*;

declare_id!("AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL");

#[program]
pub mod tidebook {
    use super::*;

    /// Appends a funded order after the verified tail at an existing price.
    pub fn append_prediction_order(
        ctx: Context<AppendPredictionOrder>,
        order_id: u64,
        outcome: PredictionOutcome,
        side: OrderSide,
        price: u64,
        quantity: u64,
    ) -> Result<()> {
        instructions::append_prediction_order::handle_append_prediction_order(
            ctx, order_id, outcome, side, price, quantity,
        )
    }

    /// Locks trader claims and seeds the first resting order on an empty side.
    pub fn place_prediction_order(
        ctx: Context<PlacePredictionOrder>,
        order_id: u64,
        outcome: PredictionOutcome,
        side: OrderSide,
        price: u64,
        quantity: u64,
    ) -> Result<()> {
        instructions::place_prediction_order::handle_place_prediction_order(
            ctx, order_id, outcome, side, price, quantity,
        )
    }

    /// Creates a draft prediction market, book, metadata, fees and collateral vault.
    pub fn initialize_prediction_market(
        ctx: Context<InitializePredictionMarket>,
        market_id: [u8; 32],
        config: prediction_config::PredictionMarketConfig,
        display_name: String,
        collateral_symbol: String,
    ) -> Result<()> {
        instructions::initialize_prediction_market::handle_initialize_prediction_market(
            ctx,
            market_id,
            config,
            display_name,
            collateral_symbol,
        )
    }

    /// Creates the signing wallet's zeroed prediction-position ledger.
    pub fn initialize_prediction_position(
        ctx: Context<InitializePredictionPosition>,
    ) -> Result<()> {
        instructions::initialize_prediction_position::handle_initialize_prediction_position(ctx)
    }

    /// Deposits collateral and atomically credits the owner's free balance.
    pub fn deposit_prediction_collateral(
        ctx: Context<DepositPredictionCollateral>,
        amount: u64,
    ) -> Result<()> {
        instructions::deposit_prediction_collateral::handle_deposit_prediction_collateral(
            ctx, amount,
        )
    }

    /// Moves a draft to Open before close under its stored authority.
    pub fn open_prediction_market(ctx: Context<OpenPredictionMarket>) -> Result<()> {
        instructions::open_prediction_market::handle_open_prediction_market(ctx)
    }

    /// Withdraws only free collateral, including after trading or resolution.
    pub fn withdraw_prediction_collateral(
        ctx: Context<WithdrawPredictionCollateral>,
        amount: u64,
    ) -> Result<()> {
        instructions::withdraw_prediction_collateral::handle_withdraw_prediction_collateral(
            ctx, amount,
        )
    }

    /// Reserves one payout of cash per newly created YES/NO pair.
    pub fn split_prediction_complete_set(
        ctx: Context<PredictionCompleteSet>,
        quantity: u64,
    ) -> Result<()> {
        instructions::prediction_complete_set::handle_split_prediction_complete_set(ctx, quantity)
    }

    /// Burns free YES/NO pairs and releases their backing into free cash.
    pub fn merge_prediction_complete_set(
        ctx: Context<PredictionCompleteSet>,
        quantity: u64,
    ) -> Result<()> {
        instructions::prediction_complete_set::handle_merge_prediction_complete_set(ctx, quantity)
    }

    /// Creates a configured market and its canonical base/quote token vaults.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        price_tick_size: u64,
        quantity_lot_size: u64,
    ) -> Result<()> {
        crate::instructions::initialize::handle_initialize_market(
            ctx,
            price_tick_size,
            quantity_lot_size,
        )
    }

    /// Attaches immutable classification and mutable labels to a market.
    pub fn initialize_market_metadata(
        ctx: Context<InitializeMarketMetadata>,
        base_symbol: String,
        quote_symbol: String,
        display_name: String,
        kind: MarketKind,
    ) -> Result<()> {
        crate::instructions::market_metadata::handle_initialize_market_metadata(
            ctx,
            base_symbol,
            quote_symbol,
            display_name,
            kind,
        )
    }

    /// Updates market labels while preserving its original classification.
    pub fn update_market_metadata(
        ctx: Context<UpdateMarketMetadata>,
        base_symbol: String,
        quote_symbol: String,
        display_name: String,
    ) -> Result<()> {
        crate::instructions::market_metadata::handle_update_market_metadata(
            ctx,
            base_symbol,
            quote_symbol,
            display_name,
        )
    }

    /// Reclaims metadata rent before the authority closes a paused market.
    pub fn close_market_metadata(ctx: Context<CloseMarketMetadata>) -> Result<()> {
        crate::instructions::market_metadata::handle_close_market_metadata(ctx)
    }

    /// Stops new order placement while preserving cancellation access.
    pub fn pause_market(ctx: Context<PauseMarket>) -> Result<()> {
        crate::instructions::pause::handle_pause_market(ctx)
    }

    /// Returns a paused market to active trading state.
    pub fn unpause_market(ctx: Context<UnpauseMarket>) -> Result<()> {
        crate::instructions::unpause::handle_unpause_market(ctx)
    }
    /// Closes a paused market account and returns its rent to its authority.
    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        crate::instructions::close::handle_close_market(ctx)
    }

    /// Creates singleton governance state and the deployer's admin record.
    pub fn initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
        crate::instructions::initialize_protocol::handle_initialize_protocol(ctx)
    }

    /// Grants an administrator role through an independent PDA record.
    pub fn add_admin(ctx: Context<AddAdmin>, new_admin: Pubkey) -> Result<()> {
        crate::instructions::add_admin::handle_add_admin(ctx, new_admin)
    }

    /// Suspends an administrator without deleting its provenance record.
    pub fn disable_admin(ctx: Context<ManageAdmin>, target_admin: Pubkey) -> Result<()> {
        crate::instructions::manage_admin::handle_disable_admin(ctx, target_admin)
    }

    /// Restores a previously disabled administrator.
    pub fn enable_admin(ctx: Context<ManageAdmin>, target_admin: Pubkey) -> Result<()> {
        crate::instructions::manage_admin::handle_enable_admin(ctx, target_admin)
    }

    /// Closes a disabled administrator record and returns its rent.
    pub fn remove_admin(ctx: Context<RemoveAdmin>, target_admin: Pubkey) -> Result<()> {
        crate::instructions::remove_admin::handle_remove_admin(ctx, target_admin)
    }

    /// Updates the global quote-denominated taker fee in basis points.
    pub fn set_taker_fee(ctx: Context<SetTakerFee>, taker_fee_bps: u16) -> Result<()> {
        crate::instructions::set_taker_fee::handle_set_taker_fee(ctx, taker_fee_bps)
    }

    /// Registers valueless test mints and transfers their authorities to a PDA.
    pub fn initialize_test_faucet(
        ctx: Context<InitializeTestFaucet>,
        base_claim_amount: u64,
        quote_claim_amount: u64,
    ) -> Result<()> {
        crate::instructions::test_faucet::handle_initialize_test_faucet(
            ctx,
            base_claim_amount,
            quote_claim_amount,
        )
    }

    /// Mints fixed test-token amounts to any connected wallet.
    pub fn claim_test_tokens(ctx: Context<ClaimTestTokens>) -> Result<()> {
        crate::instructions::test_faucet::handle_claim_test_tokens(ctx)
    }

    /// Permanently disables a market's test faucet before safe market closure.
    pub fn close_test_faucet(ctx: Context<CloseTestFaucet>) -> Result<()> {
        crate::instructions::test_faucet::handle_close_test_faucet(ctx)
    }

    /// Lets an order owner cancel an open order, including while paused.
    pub fn cancel_limit_order(ctx: Context<CancelLimitOrder>, order_id: u64) -> Result<()> {
        crate::instructions::cancel_limit_order::handle_cancel_limit_order(ctx, order_id)
    }

    /// Appends an order behind the current tail of an existing price level.
    pub fn append_limit_order(
        ctx: Context<AppendLimitOrder>,
        side: OrderSide,
        price: u64,
        quantity: u64,
    ) -> Result<()> {
        crate::instructions::append_limit_order::handle_append_limit_order(
            ctx, side, price, quantity,
        )
    }

    /// Inserts an order at a new distinct sorted price level.
    pub fn insert_limit_order(
        ctx: Context<InsertLimitOrder>,
        side: OrderSide,
        price: u64,
        quantity: u64,
    ) -> Result<()> {
        crate::instructions::insert_limit_order::handle_insert_limit_order(
            ctx, side, price, quantity,
        )
    }

    /// Creates the caller's canonical zeroed balance ledger for a market.
    pub fn initialize_trader_balance(ctx: Context<InitializeTraderBalance>) -> Result<()> {
        crate::instructions::initialize_trader_balance::handle_initialize_trader_balance(ctx)
    }

    /// Deposits base or quote tokens and credits the caller's free balance.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        crate::instructions::deposit::handle_deposit(ctx, amount)
    }

    /// Withdraws free base or quote tokens to the caller's token account.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        crate::instructions::withdraw::handle_withdraw(ctx, amount)
    }

    /// Transfers accrued quote-denominated protocol revenue to a treasury.
    pub fn withdraw_protocol_fees(ctx: Context<WithdrawProtocolFees>, amount: u64) -> Result<()> {
        crate::instructions::withdraw_protocol_fees::handle_withdraw_protocol_fees(ctx, amount)
    }

    /// Settles against one best FIFO maker and removes it when fully filled.
    pub fn match_limit_order(
        ctx: Context<MatchLimitOrder>,
        taker_side: OrderSide,
        limit_price: u64,
        quantity: u64,
    ) -> Result<()> {
        crate::instructions::match_limit_order::handle_match_limit_order(
            ctx,
            taker_side,
            limit_price,
            quantity,
        )
    }
}
