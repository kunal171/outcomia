//! Outcomia's on-chain Anchor program entrypoints.
//!
//! The crate delegates account validation and state transitions to focused
//! instruction modules while exposing a stable interface for generated clients.
//!
//! Public functions below are Anchor instruction entrypoints: their arguments
//! and account contexts form the client-facing interface. Anchor checks account
//! ownership, seeds, signers and constraints before calling a handler. A UI
//! route or wallet badge is never an authorization boundary.
//!
//! Spot quantities are base-mint atoms; prediction quantities are whole YES/NO
//! contracts. Both use integer collateral/quote prices. Only custody instructions
//! move SPL tokens; resting orders, matching and cancellation move backed
//! internal claims. Handler modules explain those state transitions in detail.

pub mod constants;
pub mod errors;
pub mod events;
pub mod fees;
pub mod instructions;
pub mod matching;
pub mod pda;
pub mod prediction_config;
mod prediction_orders;
pub mod shared_trading;
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
pub mod outcomia {
    use super::*;

    /// Proposes/corrects a published outcome. Inputs: active resolver, outcome and evidence.
    /// Errors: role, timing, state or evidence. Returns: restarted delayed proposal, no payout yet.
    pub fn propose_prediction(
        ctx: Context<ResolvePrediction>,
        outcome: PredictionResolution,
        evidence_uri: String,
        evidence_hash: [u8; 32],
        correction: bool,
    ) -> Result<()> {
        instructions::prediction_resolution::handle_propose_prediction(
            ctx,
            outcome,
            evidence_uri,
            evidence_hash,
            correction,
        )
    }
    /// Stops trading early. Inputs: active-admin creator and market. Errors: role/state.
    /// Returns: Frozen state without accelerating the resolution clock.
    pub fn close_prediction_trading(ctx: Context<ResolvePrediction>) -> Result<()> {
        instructions::prediction_resolution::handle_close_prediction_trading(ctx)
    }
    /// Advances a published resolution clock. Inputs: market/action (0 freeze, 1 fallback,
    /// 2 finalize, 3 Invalid timeout). Errors: unmet clock/state. Returns: monotonic transition.
    pub fn advance_prediction(ctx: Context<AdvancePrediction>, action: u8) -> Result<()> {
        instructions::prediction_resolution::handle_advance_prediction(ctx, action)
    }
    /// Splits/merges backed pairs. Inputs: shared custody, quantity, split flag.
    /// Errors: lifecycle, funds, arithmetic or CPI. Returns: equal cash/reserve movement.
    pub fn shared_complete_set(
        ctx: Context<SharedPredictionCustody>,
        quantity: u64,
        split: bool,
    ) -> Result<()> {
        instructions::shared_prediction::handle_shared_complete_set(ctx, quantity, split)
    }
    /// Redeems free outcomes. Inputs: shared custody and YES/NO quantities. Errors: state,
    /// claims, arithmetic/CPI. Returns: burned contracts and fixed payout in shared free balance.
    pub fn redeem_prediction(
        ctx: Context<SharedPredictionCustody>,
        yes: u64,
        no: u64,
    ) -> Result<()> {
        instructions::shared_prediction::handle_redeem_prediction(ctx, yes, no)
    }

    /// Fills one shared-wallet maker. Inputs: taker/book/config, both users' claims, FIFO hints
    /// and exact order units. Errors: priority/funds/accounts/overflow. Returns: atomic maker-price fill.
    pub fn match_shared_order(
        ctx: Context<MatchSharedOrder>,
        outcome: SharedOutcome,
        taker_side: OrderSide,
        limit_price: u64,
        quantity: u64,
    ) -> Result<()> {
        instructions::shared_match::handle_match_shared_order(
            ctx,
            outcome,
            taker_side,
            limit_price,
            quantity,
        )
    }

    /// Inserts a shared-wallet limit order. Inputs: owner/book/claims/hints and exact order units.
    /// Errors: closed/crossing/grid/identity/funds/overflow. Returns: funded FIFO order.
    pub fn place_shared_order(
        ctx: Context<PlaceSharedOrder>,
        outcome: SharedOutcome,
        side: OrderSide,
        price: u64,
        quantity: u64,
        order_id: u64,
    ) -> Result<()> {
        instructions::shared_orders::handle_place_shared_order(
            ctx, outcome, side, price, quantity, order_id,
        )
    }
    /// Cancels a shared order. Inputs: owner, claim accounts and queue removal hints. Errors:
    /// foreign/non-Open order, stale links or arithmetic. Returns: released remainder and repaired book.
    pub fn cancel_shared_order(ctx: Context<CancelSharedOrder>) -> Result<()> {
        instructions::shared_orders::handle_cancel_shared_order(ctx)
    }

    /// Closes a drained root. Inputs: active-admin creator, stopped source/root. Errors:
    /// role, lifecycle or outstanding orders/fees. Returns: root rent; global user funds remain.
    pub fn close_shared_book(ctx: Context<CloseSharedBook>) -> Result<()> {
        instructions::shared_book::handle_close_shared_book(ctx)
    }

    /// Creates an admin-owned shared execution book. Inputs: creator, source market and kind.
    /// Errors: role/binding/duplicate/rent. Returns: empty namespaced book and zero fee claim.
    pub fn initialize_shared_book(
        ctx: Context<InitializeSharedBook>,
        kind: MarketKind,
    ) -> Result<()> {
        instructions::shared_book::handle_initialize_shared_book(ctx, kind)
    }
    /// Withdraws book-earned shared fees. Inputs: super-admin/config, book/vault and raw amount.
    /// Errors: ownership, amount or CPI. Returns: equal fee/custody debit, no trader claim change.
    pub fn withdraw_shared_fees(ctx: Context<WithdrawSharedFees>, amount: u64) -> Result<()> {
        instructions::shared_book::handle_withdraw_shared_fees(ctx, amount)
    }

    /// Creates the owner's reusable mint ledger. Inputs: owner/mint/vault. Errors: duplicate or
    /// invalid custody/rent. Returns: zero shared balance; no deposit.
    pub fn initialize_asset_balance(ctx: Context<InitializeAssetBalance>) -> Result<()> {
        instructions::asset_wallet::handle_initialize_asset_balance(ctx)
    }
    /// Deposits mint atoms. Inputs: owner/ledger/source/vault, amount. Errors: bad funds/binding or
    /// overflow/CPI. Returns: equal shared-custody and free-claim credit.
    pub fn deposit_asset(ctx: Context<TransferAsset>, amount: u64) -> Result<()> {
        instructions::asset_wallet::handle_deposit_asset(ctx, amount)
    }
    /// Withdraws only free atoms. Inputs: owner/ledger/destination/vault, amount. Errors: bad
    /// binding, insufficient free/vault funds or CPI. Returns: equal custody/free debit.
    pub fn withdraw_asset(ctx: Context<TransferAsset>, amount: u64) -> Result<()> {
        instructions::asset_wallet::handle_withdraw_asset(ctx, amount)
    }
    /// Migrates legacy spot free atoms. Inputs: owner, market and shared custody, amount. Errors:
    /// wrong binding, insufficient free cash or overflow/CPI. Returns: atomic transfer and credit.
    pub fn migrate_spot_asset(ctx: Context<MigrateSpotAsset>, amount: u64) -> Result<()> {
        instructions::asset_wallet::handle_migrate_spot_asset(ctx, amount)
    }
    /// Migrates legacy prediction free cash. Inputs: owner/position/two vaults, amount. Errors:
    /// binding/funds/overflow/CPI. Returns: shared credit, leaving reserves and orders intact.
    pub fn migrate_prediction_asset(
        ctx: Context<MigratePredictionAsset>,
        amount: u64,
    ) -> Result<()> {
        instructions::asset_wallet::handle_migrate_prediction_asset(ctx, amount)
    }

    /// Settles up to one best FIFO maker; excess taker quantity is not posted.
    ///
    /// # Inputs
    /// `ctx`: taker, market/book/config/fees, best FIFO maker, two positions and removal hints;
    /// outcome, side, limit and whole quantity.
    ///
    /// # Errors
    /// Closed trading, invalid grid/backing/accounts, skipped priority, self/same-side/noncrossing
    /// trade, insufficient claims, overflow or stale hints.
    ///
    /// # Returns
    /// `Ok(())` after up to one maker fills at its resting price; excess stays unposted and next
    /// order ID is unchanged.
    pub fn match_prediction_order(
        ctx: Context<MatchPredictionOrder>,
        outcome: PredictionOutcome,
        taker_side: OrderSide,
        limit_price: u64,
        quantity: u64,
    ) -> Result<()> {
        instructions::match_prediction_order::handle_match_prediction_order(
            ctx,
            outcome,
            taker_side,
            limit_price,
            quantity,
        )
    }

    /// Releases only the signing owner's unfilled claims, even after trading closes.
    ///
    /// # Inputs
    /// `ctx`: owner, position/book/order/level, FIFO hints and final-level price/rent hints;
    /// existing `order_id`.
    ///
    /// # Errors
    /// Foreign/non-Open order, bad backing/counts/links, stale or redundant hints, wrong rent
    /// recipient, refund overflow or locked underflow.
    ///
    /// # Returns
    /// `Ok(())` after refunding only the remainder and retaining Canceled history; final levels
    /// close without a trading-time gate.
    pub fn cancel_prediction_order(
        ctx: Context<CancelPredictionOrder>,
        order_id: u64,
    ) -> Result<()> {
        instructions::cancel_prediction_order::handle_cancel_prediction_order(ctx, order_id)
    }

    /// Inserts a funded order between verified adjacent prices on an occupied side.
    ///
    /// # Inputs
    /// `ctx`: trader/position, market/book, new order/level and adjacent hints; ID, outcome, side,
    /// price and whole quantity.
    ///
    /// # Errors
    /// Closed trading, crossing/bad price, stale ID/adjacency, wrong namespace, empty-side misuse,
    /// insufficient funds or overflow.
    ///
    /// # Returns
    /// `Ok(())` after a funded best/middle/worst splice; same-price submissions must append.
    pub fn insert_prediction_order(
        ctx: Context<InsertPredictionOrder>,
        order_id: u64,
        outcome: PredictionOutcome,
        side: OrderSide,
        price: u64,
        quantity: u64,
    ) -> Result<()> {
        instructions::insert_prediction_order::handle_insert_prediction_order(
            ctx, order_id, outcome, side, price, quantity,
        )
    }

    /// Appends a funded order after the verified tail at an existing price.
    ///
    /// # Inputs
    /// `ctx`: trader/position, market/book, existing level/tail and new order; ID, outcome, side,
    /// price and whole quantity.
    ///
    /// # Errors
    /// Closed trading, invalid price/ID/funding, wrong level, stale tail, counter overflow or
    /// account initialization failure.
    ///
    /// # Returns
    /// `Ok(())` after locking only this trader's claims and appending a node; first order and price
    /// neighbors are retained.
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
    ///
    /// # Inputs
    /// `ctx`: owner/position, Open market/book and new order/level; current ID, outcome, side, raw
    /// price and whole quantity.
    ///
    /// # Errors
    /// Closed trading, occupied side, crossing/off-tick price, stale ID, insufficient funds,
    /// overflow or account creation failure.
    ///
    /// # Returns
    /// `Ok(())` with updated head/IDs/counts and a backed order; no vault transfer or taker fee.
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
    ///
    /// # Inputs
    /// `ctx`: active creator, collateral mint and new market/vault/metadata/fees/book; 32-byte ID,
    /// rules config, display name and symbol.
    ///
    /// # Errors
    /// Invalid terms/labels/payout, resolver different from creator, role/PDA/duplicate/allocation
    /// or token-account creation failure.
    ///
    /// # Returns
    /// `Ok(())` with five new accounts and zero claims/supply/reserve; opening and funding are
    /// separate.
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
    ///
    /// # Inputs
    /// `ctx`: owner signer/payer, canonical prediction market and new `(market, owner)` position.
    ///
    /// # Errors
    /// Duplicate position, incorrect PDA/market, insufficient rent or allocation failure.
    ///
    /// # Returns
    /// `Ok(())` with all six cash/YES/NO free and locked buckets zero; no assets are issued.
    pub fn initialize_prediction_position(
        ctx: Context<InitializePredictionPosition>,
    ) -> Result<()> {
        instructions::initialize_prediction_position::handle_initialize_prediction_position(ctx)
    }

    /// Deposits collateral and atomically credits the owner's free balance.
    ///
    /// # Inputs
    /// `ctx`: owner/position, collateral mint, owner source and canonical vault; positive raw
    /// `amount`.
    ///
    /// # Errors
    /// Resolved market, zero amount, wrong source/mint/PDA, insufficient tokens, credit overflow or
    /// failed CPI.
    ///
    /// # Returns
    /// `Ok(())` after custody/free cash increase equally; supply and payout reserve do not change.
    pub fn deposit_prediction_collateral(
        ctx: Context<DepositPredictionCollateral>,
        amount: u64,
    ) -> Result<()> {
        instructions::deposit_prediction_collateral::handle_deposit_prediction_collateral(
            ctx, amount,
        )
    }

    /// Moves a draft to Open before close under its stored authority.
    ///
    /// # Inputs
    /// `ctx`: stored creator signer, canonical Draft and that creator's Active admin record.
    ///
    /// # Errors
    /// Wrong creator/admin/resolver, `PredictionNotDraft` or `PredictionOpeningClosed` at/after
    /// close.
    ///
    /// # Returns
    /// `Ok(())` after changing only status to Open; rules, claims and counters are preserved.
    pub fn open_prediction_market(ctx: Context<OpenPredictionMarket>) -> Result<()> {
        instructions::open_prediction_market::handle_open_prediction_market(ctx)
    }

    /// Withdraws only free collateral, including after trading or resolution.
    ///
    /// # Inputs
    /// `ctx`: owner/position, collateral mint, owner destination and canonical vault; positive raw
    /// `amount`.
    ///
    /// # Errors
    /// Zero amount, wrong destination/mint/PDA, insufficient free cash/vault funds or rejected CPI.
    ///
    /// # Returns
    /// `Ok(())` after token transfer and free-claim debit; no lifecycle gate blocks existing
    /// free-cash recovery.
    pub fn withdraw_prediction_collateral(
        ctx: Context<WithdrawPredictionCollateral>,
        amount: u64,
    ) -> Result<()> {
        instructions::withdraw_prediction_collateral::handle_withdraw_prediction_collateral(
            ctx, amount,
        )
    }

    /// Reserves one payout of cash per newly created YES/NO pair.
    ///
    /// # Inputs
    /// `ctx`: owner position and canonical market; `quantity`: positive whole pairs, not token
    /// atoms.
    ///
    /// # Errors
    /// Not Open, at/after close, zero quantity, insufficient cash or multiplication/supply/reserve
    /// overflow.
    ///
    /// # Returns
    /// `Ok(())` after reserving `quantity * payout_per_contract` and issuing equal YES/NO; vault
    /// tokens do not move.
    pub fn split_prediction_complete_set(
        ctx: Context<PredictionCompleteSet>,
        quantity: u64,
    ) -> Result<()> {
        instructions::prediction_complete_set::handle_split_prediction_complete_set(ctx, quantity)
    }

    /// Burns free YES/NO pairs and releases their backing into free cash.
    ///
    /// # Inputs
    /// `ctx`: owner position and canonical market; `quantity`: positive whole free pairs.
    ///
    /// # Errors
    /// Status outside Open/Frozen/Proposed, insufficient free pairs, supply/reserve underflow or
    /// refund overflow.
    ///
    /// # Returns
    /// `Ok(())` after equal YES/NO burns and a reserve-to-free-cash refund; locked contracts are
    /// excluded.
    pub fn merge_prediction_complete_set(
        ctx: Context<PredictionCompleteSet>,
        quantity: u64,
    ) -> Result<()> {
        instructions::prediction_complete_set::handle_merge_prediction_complete_set(ctx, quantity)
    }

    /// Creates a configured market and its canonical base/quote token vaults.
    ///
    /// # Inputs
    /// `ctx`: active admin, distinct SPL mints and new market/fees/vaults; raw `price_tick_size`
    /// and `quantity_lot_size`.
    ///
    /// # Errors
    /// Zero tick/lot, identical/invalid mints, inactive admin, duplicate/PDA/allocation or
    /// token-account creation failures.
    ///
    /// # Returns
    /// `Ok(())` with an Active empty book, next ID 1, two empty vaults and zero accrued fees.
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
    ///
    /// # Inputs
    /// `ctx`: active admin, spot market and bound metadata; replacement symbols and display name.
    ///
    /// # Errors
    /// Invalid labels, inactive/unauthorized admin or incorrect metadata binding.
    ///
    /// # Returns
    /// `Ok(())` after replacing labels and emitting an update; kind and token mints remain
    /// unchanged.
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
    ///
    /// # Inputs
    /// `ctx`: stored authority signer, Paused market and its metadata PDA.
    ///
    /// # Errors
    /// Wrong authority, non-Paused market or incorrect metadata binding.
    ///
    /// # Returns
    /// `Ok(())` and an event; Anchor returns metadata rent without closing vaults or market.
    pub fn close_market_metadata(ctx: Context<CloseMarketMetadata>) -> Result<()> {
        crate::instructions::market_metadata::handle_close_market_metadata(ctx)
    }

    /// Stops new order placement while preserving cancellation access.
    ///
    /// # Inputs
    /// `ctx`: stored spot-market authority signer and Active market.
    ///
    /// # Errors
    /// Wrong authority or `MarketAlreadyPaused` for a non-Active market.
    ///
    /// # Returns
    /// `Ok(())` after Active becomes Paused; orders and owner cancellation/withdrawal rights
    /// remain.
    pub fn pause_market(ctx: Context<PauseMarket>) -> Result<()> {
        crate::instructions::pause::handle_pause_market(ctx)
    }

    /// Returns a paused market to active trading state.
    ///
    /// # Inputs
    /// `ctx`: stored authority signer and Paused spot market.
    ///
    /// # Errors
    /// Wrong authority or `MarketAlreadyActive` for a non-Paused market.
    ///
    /// # Returns
    /// `Ok(())` after Paused becomes Active, preserving balances, book links and IDs.
    pub fn unpause_market(ctx: Context<UnpauseMarket>) -> Result<()> {
        crate::instructions::unpause::handle_unpause_market(ctx)
    }
    /// Closes a paused market account and returns its rent to its authority.
    ///
    /// # Inputs
    /// `ctx`: stored authority, Paused market, fee record, canonical vaults and empty faucet PDA.
    ///
    /// # Errors
    /// Open orders, nonzero fees/vault tokens, existing faucet, wrong authority/accounts or failed
    /// token close.
    ///
    /// # Returns
    /// `Ok(())` after vault closure; Anchor closes market/fees and refunds rent. Historical
    /// orders/ledgers are not swept.
    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        crate::instructions::close::handle_close_market(ctx)
    }

    /// Creates singleton governance state and the deployer's admin record.
    ///
    /// # Inputs
    /// `ctx`: upgrade-authority signer, program/loader data and new config/deployer-role accounts.
    ///
    /// # Errors
    /// Wrong upgrade authority, duplicate initialization, invalid PDAs, allocation or rent failure.
    ///
    /// # Returns
    /// `Ok(())` with singleton governance, an Active deployer and zero taker fees.
    pub fn initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
        crate::instructions::initialize_protocol::handle_initialize_protocol(ctx)
    }

    /// Grants an administrator role through an independent PDA record.
    ///
    /// # Inputs
    /// `ctx`: super-admin signer, config and new role PDA; `new_admin`: target wallet key.
    ///
    /// # Errors
    /// `InvalidAdmin` for the default key; context checks reject unauthorized callers, wrong PDAs
    /// and duplicate roles.
    ///
    /// # Returns
    /// `Ok(())` with the new role and creation event; errors leave no new role.
    pub fn add_admin(ctx: Context<AddAdmin>, new_admin: Pubkey) -> Result<()> {
        crate::instructions::add_admin::handle_add_admin(ctx, new_admin)
    }

    /// Suspends an administrator without deleting its provenance record.
    ///
    /// # Inputs
    /// `ctx`: super-admin/config and target role; `target_admin`: wallet key constrained by the
    /// context.
    ///
    /// # Errors
    /// Unauthorized governance, protected super-admin, incorrect target or `AdminAlreadyDisabled`.
    ///
    /// # Returns
    /// `Ok(())` after status becomes Disabled and an event is emitted.
    pub fn disable_admin(ctx: Context<ManageAdmin>, target_admin: Pubkey) -> Result<()> {
        crate::instructions::manage_admin::handle_disable_admin(ctx, target_admin)
    }

    /// Restores a previously disabled administrator.
    ///
    /// # Inputs
    /// `ctx`: super-admin/config and target role; `target_admin`: wallet key constrained by the
    /// context.
    ///
    /// # Errors
    /// Unauthorized governance, protected super-admin, incorrect target or `AdminAlreadyActive`.
    ///
    /// # Returns
    /// `Ok(())` after status becomes Active while preserving who originally added the role.
    pub fn enable_admin(ctx: Context<ManageAdmin>, target_admin: Pubkey) -> Result<()> {
        crate::instructions::manage_admin::handle_enable_admin(ctx, target_admin)
    }

    /// Closes a disabled administrator record and returns its rent.
    ///
    /// # Inputs
    /// `ctx`: super-admin/config and role; `target_admin`: wallet key bound by PDA constraints.
    ///
    /// # Errors
    /// Active role, protected super-admin, unauthorized governance or incorrect account binding.
    ///
    /// # Returns
    /// `Ok(())` and a removal event; Anchor then returns role rent to the super-admin.
    pub fn remove_admin(ctx: Context<RemoveAdmin>, target_admin: Pubkey) -> Result<()> {
        crate::instructions::remove_admin::handle_remove_admin(ctx, target_admin)
    }

    /// Updates the global quote-denominated taker fee in basis points.
    ///
    /// # Inputs
    /// `ctx`: super-admin and canonical config; `taker_fee_bps`: unsigned basis points.
    ///
    /// # Errors
    /// `FeeRateTooHigh` above 1,000 bps; unauthorized or incorrectly bound config.
    ///
    /// # Returns
    /// `Ok(())` after storing the rate and emitting old/new values; accrued fees are unchanged.
    pub fn set_taker_fee(ctx: Context<SetTakerFee>, taker_fee_bps: u16) -> Result<()> {
        crate::instructions::set_taker_fee::handle_set_taker_fee(ctx, taker_fee_bps)
    }

    /// Registers valueless test mints and transfers their authorities to a PDA.
    ///
    /// # Inputs
    /// `ctx`: super-admin, market, zero-supply mints and new faucet; claim amounts in raw mint
    /// atoms.
    ///
    /// # Errors
    /// Zero amounts, existing supply, wrong mint/governance authority, account creation or either
    /// authority-transfer failure.
    ///
    /// # Returns
    /// `Ok(())` with both authorities transferred and the claim configuration stored atomically.
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
    ///
    /// # Inputs
    /// `ctx`: claimant, live faucet config, signing PDA, mints and claimant-owned destinations.
    ///
    /// # Errors
    /// Missing/misbound config, wrong mint/destination owner or either mint CPI failure; no
    /// cooldown is checked.
    ///
    /// # Returns
    /// `Ok(())` after both raw amounts are minted and an event is emitted.
    pub fn claim_test_tokens(ctx: Context<ClaimTestTokens>) -> Result<()> {
        crate::instructions::test_faucet::handle_claim_test_tokens(ctx)
    }

    /// Permanently disables a market's test faucet before safe market closure.
    ///
    /// # Inputs
    /// `ctx`: stored spot authority and canonical faucet configuration.
    ///
    /// # Errors
    /// Wrong authority or incorrect faucet/market/mint binding.
    ///
    /// # Returns
    /// `Ok(())` and a closure event; config rent is returned without handing mint authority to a
    /// wallet.
    pub fn close_test_faucet(ctx: Context<CloseTestFaucet>) -> Result<()> {
        crate::instructions::test_faucet::handle_close_test_faucet(ctx)
    }

    /// Lets an order owner cancel an open order, including while paused.
    ///
    /// # Inputs
    /// `ctx`: owner, ledger, order/level, exact FIFO hints and final-level price/rent hints;
    /// `order_id`: PDA-bound ID.
    ///
    /// # Errors
    /// Wrong owner/status, stale links, inconsistent backing/counters, refund overflow, locked
    /// underflow or incorrect rent recipient.
    ///
    /// # Returns
    /// `Ok(())` with a Canceled history account and refunded free balance; an empty level closes,
    /// even while paused.
    pub fn cancel_limit_order(ctx: Context<CancelLimitOrder>, order_id: u64) -> Result<()> {
        crate::instructions::cancel_limit_order::handle_cancel_limit_order(ctx, order_id)
    }

    /// Appends an order behind the current tail of an existing price level.
    ///
    /// # Inputs
    /// `ctx`: trader, Active market/ledger, canonical level/tail and new order; side, raw price and
    /// quantity.
    ///
    /// # Errors
    /// Invalid grid/notional, stale tail, misbound accounts, insufficient free funds, overflow or
    /// initialization failure.
    ///
    /// # Returns
    /// `Ok(())` after locking the trader's funds and extending the queue; earlier owners' claims
    /// and price links are unchanged.
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
    ///
    /// # Inputs
    /// `ctx`: trader, Active market/ledger, new order/level and adjacent hints; side, raw price and
    /// quantity.
    ///
    /// # Errors
    /// Invalid grid/notional/ordering, stale neighbors, insufficient funds, overflow or account
    /// creation failure.
    ///
    /// # Returns
    /// `Ok(())` after an atomic level/order splice and counter advance; only new-best insertion
    /// changes the head.
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
    ///
    /// # Inputs
    /// `ctx`: owner signer/payer, existing spot market and new `(market, owner)` ledger PDA.
    ///
    /// # Errors
    /// Duplicate ledger, incorrect PDA, insufficient rent or allocation failure.
    ///
    /// # Returns
    /// `Ok(())` with four zero free/locked buckets and an event; no tokens are deposited.
    pub fn initialize_trader_balance(ctx: Context<InitializeTraderBalance>) -> Result<()> {
        crate::instructions::initialize_trader_balance::handle_initialize_trader_balance(ctx)
    }

    /// Deposits base or quote tokens and credits the caller's free balance.
    ///
    /// # Inputs
    /// `ctx`: owner, ledger, selected market mint, source and vault; `amount`: positive mint atoms.
    ///
    /// # Errors
    /// Invalid amount/mint/owner, insufficient source funds, credit overflow or a failed SPL
    /// transfer.
    ///
    /// # Returns
    /// `Ok(())` after custody and the selected free bucket increase equally; locked buckets stay
    /// unchanged.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        crate::instructions::deposit::handle_deposit(ctx, amount)
    }

    /// Withdraws free base or quote tokens to the caller's token account.
    ///
    /// # Inputs
    /// `ctx`: owner/ledger, market mint, owner destination and vault; `amount`: positive mint
    /// atoms.
    ///
    /// # Errors
    /// Wrong mint/destination, zero amount, insufficient free balance/vault funds or failed SPL
    /// transfer.
    ///
    /// # Returns
    /// `Ok(())` after both custody and the free claim decrease by `amount`; locked funds cannot be
    /// withdrawn.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        crate::instructions::withdraw::handle_withdraw(ctx, amount)
    }

    /// Transfers accrued quote-denominated protocol revenue to a treasury.
    ///
    /// # Inputs
    /// `ctx`: super-admin, spot market/fees, quote mint/vault and governance destination; positive
    /// raw `amount`.
    ///
    /// # Errors
    /// Unauthorized governance, incorrect mint/destination, insufficient accrued fees/vault funds
    /// or failed token CPI.
    ///
    /// # Returns
    /// `Ok(())` after transferring fees and reducing the accumulator equally; trader claims are not
    /// debited.
    pub fn withdraw_protocol_fees(ctx: Context<WithdrawProtocolFees>, amount: u64) -> Result<()> {
        crate::instructions::withdraw_protocol_fees::handle_withdraw_protocol_fees(ctx, amount)
    }

    /// Settles against one best FIFO maker and removes it when fully filled.
    ///
    /// # Inputs
    /// `ctx`: taker, Active market/config/fees, maker/level, two ledgers and removal hints; side,
    /// raw limit and base-atom quantity.
    ///
    /// # Errors
    /// Same-side/noncrossing/self trade, skipped priority, incorrect grid/backing/accounts,
    /// insufficient funds, overflow or stale hints.
    ///
    /// # Returns
    /// `Ok(())` after one maker-price fill and fee accrual; partial priority is preserved and
    /// excess taker quantity is not posted.
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
