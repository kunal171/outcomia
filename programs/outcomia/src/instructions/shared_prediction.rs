//! Prediction contracts stay question-specific; spendable collateral is shared.
//!
//! Splitting moves real tokens from the global vault to the question reserve.
//! Merging/redemption returns backing to global custody. A losing contract can
//! be burned for zero; a winning claim is paid once because its supply is burned.
use crate::{
    constants::*,
    errors::{balance, prediction, shared},
    state::*,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
pub struct SharedPredictionCustody<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()], bump = market.bump)]
    pub market: Box<Account<'info, PredictionMarket>>,
    #[account(mut, seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()], bump = position.bump,
        has_one = owner @ prediction::PredictionPositionOwnerMismatch, has_one = market @ prediction::PredictionPositionMarketMismatch)]
    pub position: Account<'info, PredictionPosition>,
    #[account(address = market.collateral_mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [ASSET_BALANCE_SEED, owner.key().as_ref(), mint.key().as_ref()], bump = asset_balance.bump,
        has_one = owner @ shared::InvalidAssetBalance, has_one = mint @ shared::InvalidAssetBalance)]
    pub asset_balance: Account<'info, AssetBalance>,
    /// CHECK: Canonical mint-specific global authority.
    #[account(seeds = [ASSET_AUTHORITY_SEED, mint.key().as_ref()], bump)]
    pub asset_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_VAULT_SEED, mint.key().as_ref()], bump,
        token::mint = mint, token::authority = asset_authority)]
    pub asset_vault: Account<'info, TokenAccount>,
    /// CHECK: Canonical question-specific reserve authority.
    #[account(seeds = [VAULT_AUTHORITY_SEED, market.key().as_ref()], bump)]
    pub market_authority: UncheckedAccount<'info>,
    #[account(mut, address = market.collateral_vault,
        seeds = [VAULT_SEED, market.key().as_ref(), mint.key().as_ref()], bump,
        token::mint = mint, token::authority = market_authority)]
    pub market_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Borrowed custody accounts of one prediction market, independent of the
/// namespace (public or club) whose PDA constraints validated them.
pub(crate) struct Custody<'a, 'info> {
    pub market: &'a mut PredictionMarket,
    pub market_key: Pubkey,
    pub position: &'a mut PredictionPosition,
    pub balance: &'a mut AssetBalance,
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

impl<'info> SharedPredictionCustody<'info> {
    pub(crate) fn custody<'a>(
        &'a mut self,
        bumps: &SharedPredictionCustodyBumps,
    ) -> Custody<'a, 'info> {
        Custody {
            market_key: self.market.key(),
            market: &mut self.market,
            position: &mut self.position,
            balance: &mut self.asset_balance,
            mint: self.mint.to_account_info(),
            decimals: self.mint.decimals,
            asset_authority: self.asset_authority.to_account_info(),
            asset_authority_bump: bumps.asset_authority,
            asset_vault: self.asset_vault.to_account_info(),
            market_authority: self.market_authority.to_account_info(),
            market_authority_bump: bumps.market_authority,
            market_vault: self.market_vault.to_account_info(),
            token_program: self.token_program.key(),
        }
    }
}

impl Custody<'_, '_> {
    /// Transfers backing between vaults using exactly one PDA signer.
    /// # Inputs
    /// Validated custody accounts, positive atoms, true for global-to-reserve.
    /// # Errors
    /// Insufficient physical tokens, invalid SPL custody or rejected CPI.
    /// # Returns
    /// Equal physical debit/credit; caller updates claims in the same atomic instruction.
    fn transfer(&self, amount: u64, into_reserve: bool) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
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
                self.market_key,
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

    /// Creates or merges complete pairs using shared cash.
    /// # Inputs
    /// Positive whole quantity and split/merge flag.
    /// # Errors
    /// Ineligible lifecycle, insufficient free cash/contracts, overflow, reserve underflow or CPI.
    /// # Returns
    /// For 3 pairs with payout 1,000,000 atoms: cash/reserve move 3,000,000 and YES/NO each move 3.
    pub(crate) fn complete_set(&mut self, quantity: u64, split: bool) -> Result<()> {
        require!(quantity > 0, prediction::InvalidPredictionContractQuantity);
        let m = &*self.market;
        if split {
            require!(
                m.status == PredictionStatus::Open && Clock::get()?.unix_timestamp < m.close_ts,
                prediction::PredictionSplitUnavailable
            );
        } else {
            require!(
                matches!(
                    m.status,
                    PredictionStatus::Open | PredictionStatus::Frozen | PredictionStatus::Proposed
                ),
                prediction::PredictionMergeUnavailable
            );
        }
        let amount = quantity
            .checked_mul(m.payout_per_contract)
            .ok_or(prediction::PredictionAccountingOverflow)?;
        self.transfer(amount, split)?;
        let m = &mut *self.market;
        let p = &mut *self.position;
        let b = &mut *self.balance;
        if split {
            b.free = b
                .free
                .checked_sub(amount)
                .ok_or(balance::InsufficientFreeBalance)?;
            p.yes_free = p
                .yes_free
                .checked_add(quantity)
                .ok_or(prediction::PredictionAccountingOverflow)?;
            p.no_free = p
                .no_free
                .checked_add(quantity)
                .ok_or(prediction::PredictionAccountingOverflow)?;
            m.yes_supply = m
                .yes_supply
                .checked_add(quantity)
                .ok_or(prediction::PredictionAccountingOverflow)?;
            m.no_supply = m
                .no_supply
                .checked_add(quantity)
                .ok_or(prediction::PredictionAccountingOverflow)?;
            m.backing_reserve = m
                .backing_reserve
                .checked_add(amount)
                .ok_or(prediction::PredictionAccountingOverflow)?;
        } else {
            p.yes_free = p
                .yes_free
                .checked_sub(quantity)
                .ok_or(prediction::InsufficientPredictionPositions)?;
            p.no_free = p
                .no_free
                .checked_sub(quantity)
                .ok_or(prediction::InsufficientPredictionPositions)?;
            m.yes_supply = m
                .yes_supply
                .checked_sub(quantity)
                .ok_or(prediction::PredictionBackingUnderflow)?;
            m.no_supply = m
                .no_supply
                .checked_sub(quantity)
                .ok_or(prediction::PredictionBackingUnderflow)?;
            m.backing_reserve = m
                .backing_reserve
                .checked_sub(amount)
                .ok_or(prediction::PredictionBackingUnderflow)?;
            b.free = b
                .free
                .checked_add(amount)
                .ok_or(balance::FreeBalanceOverflow)?;
        }
        Ok(())
    }

    /// Burns resolved free contracts and credits their fixed payout to the shared wallet.
    /// # Inputs
    /// Whole YES/NO quantities; at least one positive quantity.
    /// # Errors
    /// Not resolved, no contracts, insufficient free claims, invalid payout, arithmetic or failed CPI.
    /// # Returns
    /// YES: yes*payout; NO: no*payout; Invalid: (yes+no)*payout/2. Locked contracts must be canceled.
    pub(crate) fn redeem(&mut self, yes: u64, no: u64) -> Result<()> {
        require!(yes > 0 || no > 0, shared::NothingToRedeem);
        let m = &*self.market;
        require!(
            m.status == PredictionStatus::Resolved,
            shared::PredictionNotResolved
        );
        let final_outcome = m.final_outcome.ok_or(shared::PredictionNotResolved)?;
        require!(
            m.payout_per_contract > 0 && m.payout_per_contract.is_multiple_of(2),
            prediction::PredictionBackingUnderflow
        );
        let amount = match final_outcome {
            PredictionResolution::Yes => u128::from(yes) * u128::from(m.payout_per_contract),
            PredictionResolution::No => u128::from(no) * u128::from(m.payout_per_contract),
            PredictionResolution::Invalid => {
                (u128::from(yes) + u128::from(no)) * u128::from(m.payout_per_contract / 2)
            }
        };
        let amount =
            u64::try_from(amount).map_err(|_| error!(prediction::PredictionAccountingOverflow))?;
        self.transfer(amount, false)?;
        let m = &mut *self.market;
        let p = &mut *self.position;
        p.yes_free = p
            .yes_free
            .checked_sub(yes)
            .ok_or(prediction::InsufficientPredictionPositions)?;
        p.no_free = p
            .no_free
            .checked_sub(no)
            .ok_or(prediction::InsufficientPredictionPositions)?;
        m.yes_supply = m
            .yes_supply
            .checked_sub(yes)
            .ok_or(prediction::PredictionBackingUnderflow)?;
        m.no_supply = m
            .no_supply
            .checked_sub(no)
            .ok_or(prediction::PredictionBackingUnderflow)?;
        m.backing_reserve = m
            .backing_reserve
            .checked_sub(amount)
            .ok_or(prediction::PredictionBackingUnderflow)?;
        self.balance.free = self
            .balance
            .free
            .checked_add(amount)
            .ok_or(balance::FreeBalanceOverflow)?;
        Ok(())
    }
}

/// Creates/merges complete pairs using shared cash, preserving legacy cash claims.
/// # Inputs
/// Owner, position, mint-ledger and both vaults; positive whole quantity and split/merge flag.
/// # Errors
/// Ineligible lifecycle, insufficient free cash/contracts, overflow, reserve underflow or CPI.
/// # Returns
/// For 3 pairs with payout 1,000,000 atoms: cash/reserve move 3,000,000 and YES/NO each move 3.
pub fn handle_shared_complete_set(
    ctx: Context<SharedPredictionCustody>,
    quantity: u64,
    split: bool,
) -> Result<()> {
    ctx.accounts
        .custody(&ctx.bumps)
        .complete_set(quantity, split)
}

/// Burns resolved free contracts and credits their fixed payout to the shared wallet.
/// # Inputs
/// Owner/custody and whole YES/NO quantities; at least one positive quantity.
/// # Errors
/// Not resolved, no contracts, insufficient free claims, invalid payout, arithmetic or failed CPI.
/// # Returns
/// YES: yes*payout; NO: no*payout; Invalid: (yes+no)*payout/2. Locked contracts must be canceled.
pub fn handle_redeem_prediction(
    ctx: Context<SharedPredictionCustody>,
    yes: u64,
    no: u64,
) -> Result<()> {
    ctx.accounts.custody(&ctx.bumps).redeem(yes, no)
}
