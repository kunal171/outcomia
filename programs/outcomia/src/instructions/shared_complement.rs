//! Complementary YES/NO fills on a shared binary book.
//!
//! A YES order and a NO order on the same side cross through the complete set.
//! Two buys mint one YES+NO pair: both buyers' collateral moves from the global
//! asset vault into the question's reserve. Two sells merge one pair: both
//! contracts burn and the reserve pays the sellers. Each fill keeps
//! `backing_reserve = YES supply * payout = NO supply * payout` and the global
//! vault equation `vault = claims + book fees`.
use crate::{
    constants::*,
    errors::{balance, fee, matching, prediction, shared},
    fees::calculate_taker_fee,
    matching::calculate_complement,
    shared_trading as rules,
    state::*,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
pub struct MatchSharedComplement<'info> {
    pub taker: Signer<'info>,
    #[account(mut, seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut, seeds = [SHARED_BOOK_SEED, market.key().as_ref()], bump = book.bump,
        has_one = market @ shared::InvalidSharedBook)]
    pub book: Box<Account<'info, SharedBook>>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut)]
    pub maker_order: Box<Account<'info, SharedOrder>>,
    #[account(mut)]
    pub price_level: Box<Account<'info, SharedPriceLevel>>,
    #[account(mut)]
    pub maker_quote: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub maker_position: Box<Account<'info, PredictionPosition>>,
    #[account(mut)]
    pub taker_quote: Box<Account<'info, AssetBalance>>,
    #[account(mut)]
    pub taker_position: Box<Account<'info, PredictionPosition>>,
    #[account(address = market.collateral_mint)]
    pub mint: Box<Account<'info, Mint>>,
    /// CHECK: Stateless PDA that signs for the global asset vault.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub asset_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = asset_authority)]
    pub asset_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: Stateless PDA that signs for the question's reserve vault.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub market_authority: UncheckedAccount<'info>,
    #[account(mut, address = market.collateral_vault,
        seeds = [VAULT_SEED, market.key().as_ref(), mint.key().as_ref()], bump,
        token::mint = mint, token::authority = market_authority)]
    pub market_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    #[account(mut)]
    pub next_order: Option<Box<Account<'info, SharedOrder>>>,
    #[account(mut)]
    pub worse_level: Option<Box<Account<'info, SharedPriceLevel>>>,
    /// CHECK: Bound to the original level payer when its final maker is removed.
    #[account(mut)]
    pub level_rent_recipient: Option<UncheckedAccount<'info>>,
}

/// Global-vault and question-reserve custody of one binary market.
pub(crate) struct Backing<'info> {
    pub market: Pubkey,
    pub mint: AccountInfo<'info>,
    pub decimals: u8,
    pub asset_authority: AccountInfo<'info>,
    pub asset_authority_bump: u8,
    pub asset_vault: AccountInfo<'info>,
    pub market_authority: AccountInfo<'info>,
    pub market_authority_bump: u8,
    pub market_vault: AccountInfo<'info>,
    pub token_program: Pubkey,
}

impl Backing<'_> {
    /// Moves `amount` collateral between the global vault and the question reserve.
    pub(crate) fn transfer(&self, amount: u64, into_reserve: bool) -> Result<()> {
        let mint = self.mint.key();
        let (from, to, authority, seed, key, bump) = if into_reserve {
            (
                self.asset_vault.clone(),
                self.market_vault.clone(),
                self.asset_authority.clone(),
                ASSET_AUTHORITY_SEED,
                mint,
                self.asset_authority_bump,
            )
        } else {
            (
                self.market_vault.clone(),
                self.asset_vault.clone(),
                self.market_authority.clone(),
                VAULT_AUTHORITY_SEED,
                self.market,
                self.market_authority_bump,
            )
        };
        let bump_bytes = [bump];
        let seeds: &[&[u8]] = &[seed, key.as_ref(), &bump_bytes];
        token::transfer_checked(
            CpiContext::new_with_signer(
                self.token_program,
                TransferChecked {
                    from,
                    mint: self.mint.clone(),
                    to,
                    authority,
                },
                &[seeds],
            ),
            amount,
            self.decimals,
        )
    }
}

/// Fills the best FIFO maker of the other outcome on the taker's side.
///
/// # Inputs
/// Taker, binary market/root/config, the maker order at the head of the other
/// outcome's best same-side level, both traders' cash and positions, both
/// vaults, exact removal hints; the taker's outcome, side, limit and contracts.
/// # Errors
/// Spot book, closed trading, self-trade, non-head/non-best maker, noncrossing
/// prices, wrong accounts, funds, reserve underflow, overflow or stale hints.
/// # Returns
/// `Ok(())` after minting (two buys) or merging (two sells) up to one maker's
/// remaining contracts at the maker's price. Fees accrue to the shared book.
pub fn handle_match_shared_complement(
    ctx: Context<MatchSharedComplement>,
    outcome: SharedOutcome,
    taker_side: OrderSide,
    limit_price: u64,
    quantity: u64,
) -> Result<()> {
    rules::trading_open(&ctx.accounts.book, &ctx.accounts.market.to_account_info())?;
    let accounts = &mut *ctx.accounts;
    let backing = Backing {
        market: accounts.market.key(),
        mint: accounts.mint.to_account_info(),
        decimals: accounts.mint.decimals,
        asset_authority: accounts.asset_authority.to_account_info(),
        asset_authority_bump: ctx.bumps.asset_authority,
        asset_vault: accounts.asset_vault.to_account_info(),
        market_authority: accounts.market_authority.to_account_info(),
        market_authority_bump: ctx.bumps.market_authority,
        market_vault: accounts.market_vault.to_account_info(),
        token_program: accounts.token_program.key(),
    };
    match_complement(
        &mut ComplementAccounts {
            taker: accounts.taker.key(),
            taker_fee_bps: accounts.protocol_config.taker_fee_bps,
            market: &mut accounts.market,
            book: &mut accounts.book,
            maker_order: &mut accounts.maker_order,
            price_level: &mut accounts.price_level,
            maker_quote: &mut accounts.maker_quote,
            maker_position: &mut accounts.maker_position,
            taker_quote: &mut accounts.taker_quote,
            taker_position: &mut accounts.taker_position,
            next_order: &mut accounts.next_order,
            worse_level: &mut accounts.worse_level,
            level_rent_recipient: &accounts.level_rent_recipient,
            backing,
        },
        outcome,
        taker_side,
        limit_price,
        quantity,
    )
    .map(|_| ())
}

/// Validated accounts of one complementary fill, independent of namespace.
/// The caller has already checked that the book's market is trading.
pub(crate) struct ComplementAccounts<'a, 'info> {
    pub taker: Pubkey,
    pub taker_fee_bps: u16,
    pub market: &'a mut Box<Account<'info, PredictionMarket>>,
    pub book: &'a mut Box<Account<'info, SharedBook>>,
    pub maker_order: &'a mut Box<Account<'info, SharedOrder>>,
    pub price_level: &'a mut Box<Account<'info, SharedPriceLevel>>,
    pub maker_quote: &'a mut Box<Account<'info, AssetBalance>>,
    pub maker_position: &'a mut Box<Account<'info, PredictionPosition>>,
    pub taker_quote: &'a mut Box<Account<'info, AssetBalance>>,
    pub taker_position: &'a mut Box<Account<'info, PredictionPosition>>,
    pub next_order: &'a mut Option<Box<Account<'info, SharedOrder>>>,
    pub worse_level: &'a mut Option<Box<Account<'info, SharedPriceLevel>>>,
    pub level_rent_recipient: &'a Option<UncheckedAccount<'info>>,
    pub backing: Backing<'info>,
}

/// Complementary fill shared by public and club books; see [`handle_match_shared_complement`].
///
/// # Returns
/// The taker fee charged, which has been accrued to the book in full.
pub(crate) fn match_complement(
    a: &mut ComplementAccounts,
    outcome: SharedOutcome,
    taker_side: OrderSide,
    limit_price: u64,
    quantity: u64,
) -> Result<u64> {
    let book = &**a.book;
    require!(
        book.kind == MarketKind::Prediction,
        shared::SharedMarketKindMismatch
    );
    let maker_outcome = match outcome {
        SharedOutcome::Yes => SharedOutcome::No,
        SharedOutcome::No => SharedOutcome::Yes,
        SharedOutcome::Spot => return err!(matching::InvalidComplementMatch),
    };
    rules::order_terms(book, outcome, taker_side, limit_price, quantity)?;
    let maker = &a.maker_order;
    let level = &a.price_level;
    rules::order(maker, book)?;
    rules::level(level, book)?;
    require!(maker.owner != a.taker, matching::SelfTradeNotAllowed);
    require!(
        maker.outcome == maker_outcome && maker.side == taker_side,
        matching::InvalidComplementMatch
    );
    require!(
        maker.price_level == level.key()
            && level.outcome == maker_outcome
            && level.side == maker.side
            && level.price == maker.price,
        shared::InvalidSharedNeighbor
    );
    let maker_slot = book.slot(maker_outcome, taker_side)?;
    require!(
        book.best_prices[maker_slot] == Some(maker.price) && level.better_price.is_none(),
        matching::MakerNotAtBestPrice
    );
    require!(
        level.first_order == Some(maker.key()) && maker.previous_order.is_none(),
        matching::MakerNotFifoHead
    );
    rules::trader(
        book,
        maker.owner,
        None,
        a.maker_quote,
        Some(&**a.maker_position),
    )?;
    rules::trader(
        book,
        a.taker,
        None,
        a.taker_quote,
        Some(&**a.taker_position),
    )?;
    let plan = calculate_complement(
        taker_side,
        limit_price,
        quantity,
        maker.side,
        maker.price,
        maker.remaining_quantity,
        maker.locked_collateral,
        book.payout_per_contract,
    )?;
    let fee = calculate_taker_fee(plan.taker_amount, a.taker_fee_bps)?;
    let accrued = book
        .accrued_quote_fees
        .checked_add(fee)
        .ok_or(fee::FeeAccrualOverflow)?;
    let remaining = maker
        .remaining_quantity
        .checked_sub(plan.quantity)
        .ok_or(shared::InvalidSharedBook)?;
    let collateral = maker
        .locked_collateral
        .checked_sub(plan.maker_locked_debit)
        .ok_or(shared::InvalidSharedBook)?;
    let total = level
        .total_remaining_quantity
        .checked_sub(plan.quantity)
        .ok_or(shared::InvalidSharedBook)?;
    if !plan.maker_fully_filled {
        require!(
            a.next_order.is_none() && a.worse_level.is_none() && a.level_rent_recipient.is_none(),
            shared::InvalidSharedNeighbor
        );
    }

    let mint = taker_side == OrderSide::Bid;
    // Real tokens move first; every later ledger check rolls this back on failure.
    a.backing.transfer(plan.reserve_amount, mint)?;

    let accounts = &mut *a;
    let m = &mut accounts.market;
    if mint {
        m.yes_supply = m
            .yes_supply
            .checked_add(plan.quantity)
            .ok_or(prediction::PredictionAccountingOverflow)?;
        m.no_supply = m
            .no_supply
            .checked_add(plan.quantity)
            .ok_or(prediction::PredictionAccountingOverflow)?;
        m.backing_reserve = m
            .backing_reserve
            .checked_add(plan.reserve_amount)
            .ok_or(prediction::PredictionAccountingOverflow)?;
        let cost = plan
            .taker_amount
            .checked_add(fee)
            .ok_or(balance::FreeBalanceOverflow)?;
        accounts.taker_quote.free = accounts
            .taker_quote
            .free
            .checked_sub(cost)
            .ok_or(balance::InsufficientFreeBalance)?;
        accounts.maker_quote.locked = accounts
            .maker_quote
            .locked
            .checked_sub(plan.maker_locked_debit)
            .ok_or(balance::LockedBalanceUnderflow)?;
        accounts.maker_quote.free = accounts
            .maker_quote
            .free
            .checked_add(plan.maker_quote_refund)
            .ok_or(balance::FreeBalanceOverflow)?;
        let (taker_free, _) = rules::base_buckets(
            MarketKind::Prediction,
            outcome,
            None,
            Some(&mut **accounts.taker_position),
        )?;
        *taker_free = taker_free
            .checked_add(plan.quantity)
            .ok_or(prediction::PredictionAccountingOverflow)?;
        let (maker_free, _) = rules::base_buckets(
            MarketKind::Prediction,
            maker_outcome,
            None,
            Some(&mut **accounts.maker_position),
        )?;
        *maker_free = maker_free
            .checked_add(plan.quantity)
            .ok_or(prediction::PredictionAccountingOverflow)?;
    } else {
        m.yes_supply = m
            .yes_supply
            .checked_sub(plan.quantity)
            .ok_or(prediction::PredictionBackingUnderflow)?;
        m.no_supply = m
            .no_supply
            .checked_sub(plan.quantity)
            .ok_or(prediction::PredictionBackingUnderflow)?;
        m.backing_reserve = m
            .backing_reserve
            .checked_sub(plan.reserve_amount)
            .ok_or(prediction::PredictionBackingUnderflow)?;
        let (taker_free, _) = rules::base_buckets(
            MarketKind::Prediction,
            outcome,
            None,
            Some(&mut **accounts.taker_position),
        )?;
        *taker_free = taker_free
            .checked_sub(plan.quantity)
            .ok_or(prediction::InsufficientPredictionPositions)?;
        let (_, maker_locked) = rules::base_buckets(
            MarketKind::Prediction,
            maker_outcome,
            None,
            Some(&mut **accounts.maker_position),
        )?;
        *maker_locked = maker_locked
            .checked_sub(plan.maker_locked_debit)
            .ok_or(balance::LockedBalanceUnderflow)?;
        let proceeds = plan
            .taker_amount
            .checked_sub(fee)
            .ok_or(fee::FeeCalculationOverflow)?;
        accounts.taker_quote.free = accounts
            .taker_quote
            .free
            .checked_add(proceeds)
            .ok_or(balance::FreeBalanceOverflow)?;
        accounts.maker_quote.free = accounts
            .maker_quote
            .free
            .checked_add(plan.maker_amount)
            .ok_or(balance::FreeBalanceOverflow)?;
    }

    if plan.maker_fully_filled {
        rules::remove_order(
            accounts.book,
            accounts.maker_order,
            accounts.price_level,
            None,
            accounts.next_order.as_deref_mut(),
            None,
            accounts.worse_level.as_deref_mut(),
            accounts.level_rent_recipient.as_ref(),
        )?;
    } else {
        accounts.price_level.total_remaining_quantity = total;
    }
    accounts.maker_order.remaining_quantity = remaining;
    accounts.maker_order.locked_collateral = collateral;
    if plan.maker_fully_filled {
        accounts.maker_order.status = OrderStatus::Filled;
        accounts.maker_order.previous_order = None;
        accounts.maker_order.next_order = None;
    }
    accounts.book.accrued_quote_fees = accrued;
    msg!(
        "Shared complement {}: market={} taker_outcome={:?} maker_price={} quantity={} fee={}",
        if mint { "mint" } else { "merge" },
        accounts.book.market,
        outcome,
        plan.maker_amount / plan.quantity,
        plan.quantity,
        fee
    );
    Ok(fee)
}
