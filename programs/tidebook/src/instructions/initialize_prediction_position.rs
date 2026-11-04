//! Creates one wallet's empty ledger in a canonical prediction market.
//!
//! The wallet signs and pays rent. No admin role, token account or vault access
//! is needed because this instruction creates no collateral or outcome claims.
//! It is independent of market lifecycle; later funding/trading instructions
//! must enforce their own status and clock constraints.

use anchor_lang::prelude::*;

use crate::{
    constants::{PREDICTION_MARKET_SEED, PREDICTION_POSITION_SEED},
    state::{PredictionMarket, PredictionPosition},
};

#[derive(Accounts)]
pub struct InitializePredictionPosition<'info> {
    /// A wallet may initialize only its own position and pays the account rent.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Validate both account type and canonical address. A spot Market account
    /// has a different discriminator and cannot be used as this ledger's market.
    #[account(
        seeds = [PREDICTION_MARKET_SEED, market.market_id.as_ref()],
        bump = market.bump
    )]
    pub market: Box<Account<'info, PredictionMarket>>,

    /// `init` deliberately rejects existing ledgers. Reinitialization must
    /// never zero out a trader's funded or locked balances.
    #[account(
        init,
        payer = owner,
        space = 8 + PredictionPosition::INIT_SPACE,
        seeds = [PREDICTION_POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, PredictionPosition>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_prediction_position(
    ctx: Context<InitializePredictionPosition>,
) -> Result<()> {
    ctx.accounts.position.set_inner(PredictionPosition {
        market: ctx.accounts.market.key(),
        owner: ctx.accounts.owner.key(),
        collateral_free: 0,
        collateral_locked: 0,
        yes_free: 0,
        yes_locked: 0,
        no_free: 0,
        no_locked: 0,
        bump: ctx.bumps.position,
    });
    Ok(())
}
