//! Owner-signed, contiguous chunk upload of large immutable terms. The normal
//! initializer validates the exact decoded terms at final creation time.
use super::multi_outcome_market::{
    handle_initialize_multi_outcome_market, InitializeMultiOutcomeMarket,
};
use crate::{errors::multi_outcome as multi, state::MultiOutcomeTerms};
use anchor_lang::prelude::*;
pub const MULTI_TERMS_SEED: &[u8] = b"multi_terms";
pub const MAX_STAGED_TERMS: usize = 2048;

#[account]
#[derive(InitSpace)]
pub struct MultiOutcomeTermsBuffer {
    pub authority: Pubkey,
    pub market_id: [u8; 32],
    #[max_len(MAX_STAGED_TERMS)]
    pub bytes: Vec<u8>,
    pub bump: u8,
}
#[derive(Accounts)]
#[instruction(market_id: [u8;32])]
pub struct WriteMultiOutcomeTerms<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init_if_needed, payer=authority, space=8+MultiOutcomeTermsBuffer::INIT_SPACE,
        seeds=[MULTI_TERMS_SEED, authority.key().as_ref(), market_id.as_ref()], bump)]
    pub buffer: Account<'info, MultiOutcomeTermsBuffer>,
    pub system_program: Program<'info, System>,
}
/// Appends at the expected offset. Replays/stale offsets fail rather than
/// silently producing another byte sequence. Offset zero resets an owner buffer.
pub fn write(
    ctx: Context<WriteMultiOutcomeTerms>,
    market_id: [u8; 32],
    offset: u32,
    bytes: Vec<u8>,
) -> Result<()> {
    let b = &mut ctx.accounts.buffer;
    require!(
        bytes.len() <= 600 && !bytes.is_empty(),
        multi::InvalidMultiOutcomeTerms
    );
    if offset == 0 {
        b.authority = ctx.accounts.authority.key();
        b.market_id = market_id;
        b.bytes.clear();
        b.bump = ctx.bumps.buffer;
    }
    require!(
        b.authority == ctx.accounts.authority.key()
            && b.market_id == market_id
            && offset as usize == b.bytes.len()
            && b.bytes.len() + bytes.len() <= MAX_STAGED_TERMS,
        multi::InvalidMultiOutcomeTerms
    );
    b.bytes.extend(bytes);
    Ok(())
}
#[derive(Accounts)]
pub struct CloseMultiOutcomeTerms<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, close=authority, seeds=[MULTI_TERMS_SEED, authority.key().as_ref(), buffer.market_id.as_ref()],
        bump=buffer.bump, has_one=authority)]
    pub buffer: Account<'info, MultiOutcomeTermsBuffer>,
}
/// The extra read-only account must be the creator's canonical buffer. A full
/// terms hash binds creation to the bytes previewed by the wallet, preventing a
/// stale upload from changing the published market. Buffer rent is recovered
/// through the separate owner-only close instruction after successful creation.
pub fn create(
    ctx: Context<InitializeMultiOutcomeMarket>,
    market_id: [u8; 32],
    terms_hash: [u8; 32],
    display_name: String,
    collateral_symbol: String,
) -> Result<()> {
    let info = ctx
        .remaining_accounts
        .first()
        .ok_or(multi::InvalidMultiOutcomeTerms)?;
    require_keys_eq!(*info.owner, crate::ID, multi::InvalidMultiOutcomeTerms);
    let (expected, _) = Pubkey::find_program_address(
        &[
            MULTI_TERMS_SEED,
            ctx.accounts.authority.key().as_ref(),
            market_id.as_ref(),
        ],
        &crate::ID,
    );
    require_keys_eq!(expected, info.key(), multi::InvalidMultiOutcomeTerms);
    let b = MultiOutcomeTermsBuffer::try_deserialize(&mut info.try_borrow_data()?.as_ref())?;
    require!(
        b.authority == ctx.accounts.authority.key() && b.market_id == market_id,
        multi::InvalidMultiOutcomeTerms
    );
    require!(
        solana_sha256_hasher::hash(&b.bytes).to_bytes() == terms_hash,
        multi::InvalidMultiOutcomeTerms
    );
    let terms = MultiOutcomeTerms::try_from_slice(&b.bytes)?;
    handle_initialize_multi_outcome_market(ctx, market_id, terms, display_name, collateral_symbol)
}
