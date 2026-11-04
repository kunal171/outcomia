//! Prediction configuration errors from the stable program-wide error catalog.

pub use super::TidebookError::{
    InvalidPredictionCloseTime, InvalidPredictionCollateralMint, InvalidPredictionFallback,
    InvalidPredictionPayout, InvalidPredictionPriceTick, InvalidPredictionResolutionDelay,
    InvalidPredictionResolutionTime, InvalidPredictionResolver, InvalidPredictionRulesHash,
    InvalidPredictionRulesUri, InvalidPredictionTokenOwner, InvalidPredictionVault,
    PredictionDepositAfterResolution, PredictionPositionMarketMismatch,
    PredictionPositionOwnerMismatch, PredictionTimestampOverflow,
};
