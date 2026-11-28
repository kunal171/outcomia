//! N-way complete-set fills on a multi-outcome book.
//!
//! A buy of one outcome plus the best buy of every other outcome funds a full
//! set: all buyers' collateral moves from the global asset vault into the
//! question reserve and every outcome's supply rises. Sells release a set: all
//! contracts burn and the reserve pays the sellers. Supplies stay equal, so
//! `backing_reserve = supply * payout` and exact Invalid refunds are preserved.
//!
//! Makers are passed as `remaining_accounts`, four per other outcome in
//! ascending outcome order: `[order, next, cash, position]`, where `next` is the
//! order's FIFO successor when it fills completely, else the program ID. One
//! owner may hold the best order on several outcomes, so cash and position
//! accounts can repeat; each unique account is loaded, updated and written once.
use crate::{
    constants::*,
    errors::{balance, fee, matching, multi_outcome as multi, prediction},
    fees::calculate_taker_fee,
    multi_outcome::plan_multi_complement,
    multi_outcome_trading as rules,
    shared_trading::asset,
    state::*,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
pub struct MatchMultiOutcomeComplement<'info> {
    pub taker: Signer<'info>,
    #[account(mut, seeds = [MULTI_OUTCOME_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(mut, seeds = [MULTI_OUTCOME_BOOK_SEED, market.key().as_ref()], bump = book.bump,
        has_one = market @ multi::InvalidMultiOutcomeBook)]
    pub book: Box<Account<'info, MultiOutcomeBook>>,
    #[account(seeds = [PROTOCOL_CONFIG_SEED], bump = protocol_config.bump)]
    pub protocol_config: Box<Account<'info, ProtocolConfig>>,
    #[account(mut, seeds = [ASSET_BALANCE_SEED, taker.key().as_ref(), market.collateral_mint.as_ref()],
        bump = taker_cash.bump)]
    pub taker_cash: Box<Account<'info, AssetBalance>>,
    #[account(mut, seeds = [MULTI_OUTCOME_POSITION_SEED, market.key().as_ref(), taker.key().as_ref()],
        bump = taker_position.bump)]
    pub taker_position: Box<Account<'info, MultiOutcomePosition>>,
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
}

/// One validated maker leg and the indexes of its deduplicated claims.
struct Leg<'info> {
    outcome: OutcomeId,
    order: Account<'info, MultiOutcomeOrder>,
    next: Option<Account<'info, MultiOutcomeOrder>>,
    cash: usize,
    position: usize,
}

/// Loads `info` once into `pool`, returning its index; repeated keys reuse it.
fn intern<'info, T: AccountSerialize + AccountDeserialize + Owner + Clone>(
    pool: &mut Vec<Account<'info, T>>,
    info: &'info AccountInfo<'info>,
) -> Result<usize> {
    if let Some(index) = pool.iter().position(|a| a.key() == info.key()) {
        return Ok(index);
    }
    require!(info.is_writable, multi::InvalidMultiOutcomeBook);
    pool.push(Account::try_from(info)?);
    Ok(pool.len() - 1)
}

/// Fills one full set against the best same-side order of every other outcome.
///
/// # Inputs
/// Taker, market/book/config, taker cash/position, both vaults and, per other
/// outcome, `[order, next, cash, position]`; the taker's outcome, side, limit,
/// contracts and the fee quote it signed.
/// # Errors
/// Closed trading, stale fee quote, missing or non-head makers, self-trade,
/// noncrossing prices, wrong accounts, funds, reserve underflow or overflow.
/// # Returns
/// `Ok(())` after minting (buys) or merging (sells) up to the smallest
/// remaining quantity, with one fill event per leg.
pub fn handle_match_multi_outcome_complement<'info>(
    mut ctx: Context<'info, MatchMultiOutcomeComplement<'info>>,
    outcome: OutcomeId,
    taker_side: OrderSide,
    limit_price: u64,
    quantity: u64,
    expected_fee_bps: u16,
) -> Result<()> {
    let e = rules::book_terms(&ctx.accounts.market, &ctx.accounts.book, true)?;
    rules::notional(e, outcome, limit_price, quantity)?;
    require!(
        ctx.accounts.protocol_config.taker_fee_bps == expected_fee_bps,
        multi::MultiOutcomeFeeQuoteChanged
    );
    let market_key = ctx.accounts.market.key();
    let book_key = ctx.accounts.book.key();
    let taker = ctx.accounts.taker.key();
    let mint = ctx.accounts.market.collateral_mint;
    asset(&ctx.accounts.taker_cash, taker, mint)?;
    rules::position(
        &ctx.accounts.market,
        &ctx.accounts.taker_position,
        taker,
        market_key,
    )?;
    let heads = rules::complement_heads(&ctx.accounts.book, e, outcome, taker_side)
        .ok_or(matching::InvalidComplementMatch)?;
    let rem = ctx.remaining_accounts;
    require!(
        rem.len() == heads.len() * 4,
        matching::InvalidComplementMatch
    );

    let mut cash: Vec<Account<'info, AssetBalance>> = Vec::new();
    let mut positions: Vec<Account<'info, MultiOutcomePosition>> = Vec::new();
    let mut legs: Vec<Leg<'info>> = Vec::with_capacity(heads.len());
    for (head, group) in heads.iter().zip(rem.chunks_exact(4)) {
        let order_info = &group[0];
        require!(order_info.is_writable, multi::InvalidMultiOutcomeBook);
        let order: Account<'info, MultiOutcomeOrder> = Account::try_from(order_info)?;
        // The book's own head reference selects each maker; a client cannot
        // substitute a worse or later order.
        require_keys_eq!(order.key(), head.order, matching::MakerNotFifoHead);
        require!(
            order.market == market_key
                && order.book == book_key
                && order.outcome == head.outcome
                && order.side == taker_side
                && order.price == head.price,
            matching::InvalidComplementMatch
        );
        rules::order_index(&ctx.accounts.book, e, order.key(), &order)?;
        require!(order.owner != taker, matching::SelfTradeNotAllowed);
        let cash_info = &group[2];
        let position_info = &group[3];
        // Load first (owner and type are checked), then bind each key to its
        // stored canonical bump: a fixed cost per maker, whatever the wallet.
        let c = intern(&mut cash, cash_info)?;
        let p = intern(&mut positions, position_info)?;
        asset(&cash[c], order.owner, mint)?;
        require!(
            crate::pda::address_with_bump(
                &[
                    MULTI_OUTCOME_POSITION_SEED,
                    market_key.as_ref(),
                    order.owner.as_ref()
                ],
                positions[p].bump
            ) == Some(position_info.key()),
            multi::InvalidMultiOutcomePosition
        );
        rules::position(&ctx.accounts.market, &positions[p], order.owner, market_key)?;
        legs.push(Leg {
            outcome: head.outcome,
            order,
            next: None,
            cash: c,
            position: p,
        });
    }

    let prices: Vec<u64> = legs.iter().map(|l| l.order.price).collect();
    let remaining: Vec<u64> = legs.iter().map(|l| l.order.remaining_quantity).collect();
    let plan = plan_multi_complement(
        e.payout_per_contract,
        taker_side,
        limit_price,
        quantity,
        &prices,
        &remaining,
    )?;
    let q = plan.quantity;
    let fee = calculate_taker_fee(plan.taker_amount, expected_fee_bps)?;
    let accrued = ctx
        .accounts
        .book
        .accrued_collateral_fees
        .checked_add(fee)
        .ok_or(fee::FeeAccrualOverflow)?;

    // A completely filled maker leaves the book; its successor becomes head.
    for (leg, group) in legs.iter_mut().zip(rem.chunks_exact(4)) {
        let next_info = &group[1];
        if leg.order.remaining_quantity == q {
            match leg.order.next {
                Some(expected) => {
                    require_keys_eq!(next_info.key(), expected, multi::InvalidMultiOutcomeBook);
                    require!(next_info.is_writable, multi::InvalidMultiOutcomeBook);
                    leg.next = Some(Account::try_from(next_info)?);
                }
                None => {
                    require_keys_eq!(next_info.key(), crate::ID, multi::InvalidMultiOutcomeBook)
                }
            }
        } else {
            require_keys_eq!(next_info.key(), crate::ID, multi::InvalidMultiOutcomeBook);
        }
    }

    let minting = taker_side == OrderSide::Bid;
    {
        // Real tokens move first; every later failure rolls the transfer back.
        let a = &ctx.accounts;
        let market = a.market.key();
        let (from, to, authority, seed, key, bump) = if minting {
            (
                a.asset_vault.to_account_info(),
                a.market_vault.to_account_info(),
                a.asset_authority.to_account_info(),
                ASSET_AUTHORITY_SEED,
                mint,
                ctx.bumps.asset_authority,
            )
        } else {
            (
                a.market_vault.to_account_info(),
                a.asset_vault.to_account_info(),
                a.market_authority.to_account_info(),
                VAULT_AUTHORITY_SEED,
                market,
                ctx.bumps.market_authority,
            )
        };
        let bump_bytes = [bump];
        let seeds: &[&[u8]] = &[seed, key.as_ref(), &bump_bytes];
        token::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from,
                    mint: a.mint.to_account_info(),
                    to,
                    authority,
                },
                &[seeds],
            ),
            plan.reserve_amount,
            a.mint.decimals,
        )?;
    }

    let accounts = &mut ctx.accounts;
    let i = usize::from(outcome.index());
    for index in 0..usize::from(e.outcome_count) {
        let supply = &mut accounts.market.supplies[index];
        *supply = if minting {
            supply
                .checked_add(q)
                .ok_or(prediction::PredictionAccountingOverflow)?
        } else {
            supply
                .checked_sub(q)
                .ok_or(prediction::PredictionBackingUnderflow)?
        };
    }
    accounts.market.backing_reserve = if minting {
        accounts
            .market
            .backing_reserve
            .checked_add(plan.reserve_amount)
            .ok_or(prediction::PredictionAccountingOverflow)?
    } else {
        accounts
            .market
            .backing_reserve
            .checked_sub(plan.reserve_amount)
            .ok_or(prediction::PredictionBackingUnderflow)?
    };
    if minting {
        let cost = plan
            .taker_amount
            .checked_add(fee)
            .ok_or(balance::FreeBalanceOverflow)?;
        accounts.taker_cash.free = accounts
            .taker_cash
            .free
            .checked_sub(cost)
            .ok_or(balance::InsufficientFreeBalance)?;
        accounts.taker_position.free[i] = accounts.taker_position.free[i]
            .checked_add(q)
            .ok_or(balance::FreeBalanceOverflow)?;
    } else {
        let proceeds = plan
            .taker_amount
            .checked_sub(fee)
            .ok_or(fee::FeeCalculationOverflow)?;
        accounts.taker_position.free[i] = accounts.taker_position.free[i]
            .checked_sub(q)
            .ok_or(balance::InsufficientFreeBalance)?;
        accounts.taker_cash.free = accounts
            .taker_cash
            .free
            .checked_add(proceeds)
            .ok_or(balance::FreeBalanceOverflow)?;
    }

    for (leg, amount) in legs.iter_mut().zip(plan.maker_amounts.iter().copied()) {
        let j = usize::from(leg.outcome.index());
        let c = &mut cash[leg.cash];
        let p = &mut positions[leg.position];
        if minting {
            // Maker bids lock exactly price * remaining, so the debit is exact.
            c.locked = c
                .locked
                .checked_sub(amount)
                .ok_or(balance::LockedBalanceUnderflow)?;
            p.free[j] = p.free[j]
                .checked_add(q)
                .ok_or(balance::FreeBalanceOverflow)?;
        } else {
            p.locked[j] = p.locked[j]
                .checked_sub(q)
                .ok_or(balance::LockedBalanceUnderflow)?;
            c.free = c
                .free
                .checked_add(amount)
                .ok_or(balance::FreeBalanceOverflow)?;
        }
        let key = leg.order.key();
        if leg.order.remaining_quantity == q {
            let snapshot = leg.order.clone();
            rules::unlink(
                &mut accounts.book,
                e,
                key,
                &snapshot,
                None,
                leg.next.as_mut(),
            )?;
        }
        let o = &mut leg.order;
        o.remaining_quantity = o
            .remaining_quantity
            .checked_sub(q)
            .ok_or(multi::InvalidMultiOutcomeBook)?;
        o.locked_amount = o
            .locked_amount
            .checked_sub(if minting { amount } else { q })
            .ok_or(multi::InvalidMultiOutcomeBook)?;
        if o.remaining_quantity == 0 {
            require!(o.locked_amount == 0, multi::InvalidMultiOutcomeBook);
            o.status = OrderStatus::Filled;
            o.next = None;
            o.previous = None;
        }
    }
    accounts.book.accrued_collateral_fees = accrued;
    accounts.market.open_order_count = accounts.book.open_order_count;

    // Persist every remaining account exactly once.
    for leg in &legs {
        leg.order.exit(&crate::ID)?;
        if let Some(next) = &leg.next {
            next.exit(&crate::ID)?;
        }
    }
    for c in &cash {
        c.exit(&crate::ID)?;
    }
    for p in &positions {
        p.exit(&crate::ID)?;
    }

    // Existing event type, so indexers decoding it need no change. Each maker
    // leg trades its own outcome at its price without a fee; the taker leg's
    // counterparty is the complete set, marked by the default address.
    for (leg, amount) in legs.iter().zip(plan.maker_amounts.iter().copied()) {
        emit!(crate::MultiOutcomeFillEvent {
            market: market_key,
            maker: leg.order.owner,
            taker,
            order: leg.order.key(),
            outcome: leg.outcome,
            taker_side,
            price: leg.order.price,
            quantity: q,
            collateral_atoms: amount,
            fee_atoms: 0
        });
    }
    emit!(crate::MultiOutcomeFillEvent {
        market: market_key,
        maker: Pubkey::default(),
        taker,
        order: Pubkey::default(),
        outcome,
        taker_side,
        price: plan.taker_price,
        quantity: q,
        collateral_atoms: plan.taker_amount,
        fee_atoms: fee
    });
    Ok(())
}
