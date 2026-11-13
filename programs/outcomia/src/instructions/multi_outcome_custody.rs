//! Shared-wallet funding for actual multi-outcome complete sets.
//!
//! Every state delta is checked before CPI. Solana atomicity rolls back both
//! token movements and claims if a transfer or account serialization fails.
//! Ordinary owners need no admin signature to merge their free complete sets.
use crate::{
    constants::*,
    errors::{balance, multi_outcome as multi, prediction, shared},
    events::MultiOutcomeCompleteSetEvent,
    multi_outcome::{
        complete_set_collateral, reserve_liability, validate_quantities, MultiOutcomeEconomics,
    },
    state::*,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
pub struct MultiOutcomeCustody<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [MULTI_OUTCOME_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, MultiOutcomeMarket>>,
    #[account(mut, seeds = [MULTI_OUTCOME_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump = position.bump,
        has_one = owner @ multi::InvalidMultiOutcomePosition, has_one = market @ multi::InvalidMultiOutcomePosition)]
    pub position: Account<'info, MultiOutcomePosition>,
    #[account(address = market.collateral_mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [ASSET_BALANCE_SEED, owner.key().as_ref(), mint.key().as_ref()], bump = asset_balance.bump,
        has_one = owner @ shared::InvalidAssetBalance, has_one = mint @ shared::InvalidAssetBalance)]
    pub asset_balance: Account<'info, AssetBalance>,
    /// CHECK: Canonical global mint-specific custody signer.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub asset_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = asset_authority)]
    pub asset_vault: Account<'info, TokenAccount>,
    /// CHECK: Canonical market-specific reserve signer; cannot sign for another market.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub market_authority: UncheckedAccount<'info>,
    #[account(mut, address = market.collateral_vault,
        seeds = [VAULT_SEED, market.key().as_ref(), mint.key().as_ref()], bump,
        token::mint = mint, token::authority = market_authority)]
    pub market_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Inputs: owner and canonical market/position/shared balance/vaults, positive
/// whole-lot quantity and split flag. Errors: wrong accounts/role, closed split,
/// resolved merge, malformed positions, insufficient free cash/contracts,
/// underbacking, arithmetic overflow or SPL CPI failure.
/// Returns: atomic complete-set issuance or burn with exactly Q*P atoms moved.
/// For N=3, Q=3 and P=1,000,000: move 3,000,000 atoms and 3 of every outcome.
/// Free collateral is reusable across markets; locked cash/contracts never fund
/// this path. No resolver outcome is chosen and no fees are charged here.
pub fn handle_multi_outcome_complete_set(
    ctx: Context<MultiOutcomeCustody>,
    quantity: u64,
    split: bool,
) -> Result<()> {
    let market = &ctx.accounts.market;
    if split {
        require!(
            market.status == PredictionStatus::Open
                && Clock::get()?.unix_timestamp < market.terms.close_ts,
            prediction::PredictionSplitUnavailable
        );
    } else {
        require!(
            matches!(
                market.status,
                PredictionStatus::Open | PredictionStatus::Frozen | PredictionStatus::Proposed
            ),
            prediction::PredictionMergeUnavailable
        );
    }
    // Finalization switches to independent outcome claims; a complete-set merge
    // must never share the reserve with final payout accounting.
    require!(
        market.final_outcome.is_none(),
        prediction::PredictionMergeUnavailable
    );
    let economics = MultiOutcomeEconomics::from_terms(&market.terms)?;
    let amount = complete_set_collateral(economics, quantity)?;
    require!(
        reserve_liability(economics, &market.supplies, None)? == market.backing_reserve,
        multi::MultiOutcomeReserveMismatch
    );
    // Accept unsolicited SPL donations without crediting anyone for them. Exact
    // equality here would let a one-atom donation freeze every legitimate exit.
    require!(
        ctx.accounts.market_vault.amount >= market.backing_reserve,
        multi::MultiOutcomeReserveMismatch
    );
    validate_quantities(economics, &ctx.accounts.position.free)?;
    validate_quantities(economics, &ctx.accounts.position.locked)?;
    let count = usize::from(economics.outcome_count);
    let mut supplies = market.supplies;
    let mut free = ctx.accounts.position.free;
    for index in 0..count {
        let owned = free[index]
            .checked_add(ctx.accounts.position.locked[index])
            .ok_or(multi::MultiOutcomeAccountingOverflow)?;
        require!(owned <= supplies[index], multi::InvalidMultiOutcomePosition);
        if split {
            supplies[index] = supplies[index]
                .checked_add(quantity)
                .ok_or(multi::MultiOutcomeAccountingOverflow)?;
            free[index] = free[index]
                .checked_add(quantity)
                .ok_or(multi::MultiOutcomeAccountingOverflow)?;
        } else {
            free[index] = free[index]
                .checked_sub(quantity)
                .ok_or(prediction::InsufficientPredictionPositions)?;
            supplies[index] = supplies[index]
                .checked_sub(quantity)
                .ok_or(multi::MultiOutcomeReserveMismatch)?;
        }
    }
    let (backing, cash) = if split {
        (
            market
                .backing_reserve
                .checked_add(amount)
                .ok_or(multi::MultiOutcomeAccountingOverflow)?,
            ctx.accounts
                .asset_balance
                .free
                .checked_sub(amount)
                .ok_or(balance::InsufficientFreeBalance)?,
        )
    } else {
        (
            market
                .backing_reserve
                .checked_sub(amount)
                .ok_or(multi::MultiOutcomeReserveMismatch)?,
            ctx.accounts
                .asset_balance
                .free
                .checked_add(amount)
                .ok_or(balance::FreeBalanceOverflow)?,
        )
    };
    require!(
        reserve_liability(economics, &supplies, None)? == backing,
        multi::MultiOutcomeReserveMismatch
    );
    transfer(&ctx, amount, split)?;
    ctx.accounts.market.supplies = supplies;
    ctx.accounts.market.backing_reserve = backing;
    ctx.accounts.position.free = free;
    ctx.accounts.asset_balance.free = cash;
    emit!(MultiOutcomeCompleteSetEvent {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        collateral_mint: ctx.accounts.mint.key(),
        split,
        quantity,
        collateral_atoms: amount,
        backing_reserve: backing
    });
    Ok(())
}

/// Inputs: checked canonical custody, positive exact amount, transfer direction.
/// Errors: token freeze, physical shortage or rejected CPI. Returns: real SPL
/// movement signed by the global mint authority or this market's authority.
pub(crate) fn transfer(
    ctx: &Context<MultiOutcomeCustody>,
    amount: u64,
    into_reserve: bool,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let mint = ctx.accounts.mint.key();
    let market = ctx.accounts.market.key();
    let (from, to, authority, seed, key, bump) = if into_reserve {
        (
            ctx.accounts.asset_vault.to_account_info(),
            ctx.accounts.market_vault.to_account_info(),
            ctx.accounts.asset_authority.to_account_info(),
            ASSET_AUTHORITY_SEED,
            mint,
            ctx.bumps.asset_authority,
        )
    } else {
        (
            ctx.accounts.market_vault.to_account_info(),
            ctx.accounts.asset_vault.to_account_info(),
            ctx.accounts.market_authority.to_account_info(),
            VAULT_AUTHORITY_SEED,
            market,
            ctx.bumps.market_authority,
        )
    };
    let bump_bytes = [bump];
    let seeds: &[&[u8]] = &[seed, key.as_ref(), &bump_bytes];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from,
                mint: ctx.accounts.mint.to_account_info(),
                to,
                authority,
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )
}

/// Inputs: owner, canonical custody and selected free outcome quantities.
/// Errors: unresolved/invalid result, forged ownership, lot/supply/backing,
/// replayed/locked quantities, overflow or CPI. Returns: burned owned contracts
/// and exact shared-wallet payout; losing outcomes clear without a zero transfer.
pub fn handle_redeem_multi_outcome(
    ctx: Context<MultiOutcomeCustody>,
    quantities: [u64; MULTI_OUTCOME_CAPACITY],
) -> Result<()> {
    let m = &ctx.accounts.market;
    require!(
        m.status == PredictionStatus::Resolved,
        shared::PredictionNotResolved
    );
    let result = m.final_outcome.ok_or(shared::PredictionNotResolved)?;
    let e = MultiOutcomeEconomics::from_terms(&m.terms)?;
    crate::multi_outcome_trading::position(
        m,
        &ctx.accounts.position,
        ctx.accounts.owner.key(),
        m.key(),
    )?;
    require!(quantities.iter().any(|q| *q > 0), shared::NothingToRedeem);
    let payout = crate::multi_outcome::redemption_payout(e, result, &quantities)?;
    require!(
        reserve_liability(e, &m.supplies, Some(result))? == m.backing_reserve
            && ctx.accounts.market_vault.amount >= m.backing_reserve,
        multi::MultiOutcomeReserveMismatch
    );
    let mut supply = m.supplies;
    let mut free = ctx.accounts.position.free;
    for i in 0..MULTI_OUTCOME_CAPACITY {
        free[i] = free[i]
            .checked_sub(quantities[i])
            .ok_or(prediction::InsufficientPredictionPositions)?;
        supply[i] = supply[i]
            .checked_sub(quantities[i])
            .ok_or(multi::MultiOutcomeReserveMismatch)?;
    }
    let reserve = m
        .backing_reserve
        .checked_sub(payout)
        .ok_or(multi::MultiOutcomeReserveMismatch)?;
    require!(
        reserve_liability(e, &supply, Some(result))? == reserve,
        multi::MultiOutcomeReserveMismatch
    );
    let cash = ctx
        .accounts
        .asset_balance
        .free
        .checked_add(payout)
        .ok_or(balance::FreeBalanceOverflow)?;
    transfer(&ctx, payout, false)?;
    ctx.accounts.market.supplies = supply;
    ctx.accounts.market.backing_reserve = reserve;
    ctx.accounts.position.free = free;
    ctx.accounts.asset_balance.free = cash;
    emit!(crate::MultiOutcomeRedeemedEvent {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        outcome: result,
        quantities,
        payout,
        backing_reserve: reserve
    });
    Ok(())
}
