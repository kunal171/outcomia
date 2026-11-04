//! Prediction configuration errors from the stable program-wide error catalog.

pub use super::TidebookError::{
    InsufficientPredictionPositions, InvalidPredictionCloseTime, InvalidPredictionCollateralMint,
    InvalidPredictionContractQuantity, InvalidPredictionFallback, InvalidPredictionPayout,
    InvalidPredictionPriceTick, InvalidPredictionResolutionDelay, InvalidPredictionResolutionTime,
    InvalidPredictionResolver, InvalidPredictionRulesHash, InvalidPredictionRulesUri,
    InvalidPredictionTokenOwner, InvalidPredictionVault, PredictionAccountingOverflow,
    PredictionBackingUnderflow, PredictionDepositAfterResolution, PredictionMergeUnavailable,
    PredictionPositionMarketMismatch, PredictionPositionOwnerMismatch, PredictionSplitUnavailable,
    PredictionTimestampOverflow,
};
