//! Fee-configuration and fee-calculation errors.

pub use super::OutcomiaError::{
    FeeAccrualOverflow, FeeCalculationOverflow, FeeRateTooHigh, InsufficientAccruedFees,
    InvalidFeeDestinationMint, InvalidFeeWithdrawalAmount, MarketFeesMarketMismatch,
    MarketFeesNotEmpty, MarketFeesQuoteMintMismatch,
};
