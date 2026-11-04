//! Prediction configuration errors from the stable program-wide error catalog.

pub use super::TidebookError::{
    InsufficientPredictionPositions, InvalidPredictionCloseTime, InvalidPredictionCollateralMint,
    InvalidPredictionContractQuantity, InvalidPredictionFallback, InvalidPredictionPayout,
    InvalidPredictionPriceTick, InvalidPredictionResolutionDelay, InvalidPredictionResolutionTime,
    InvalidPredictionResolver, InvalidPredictionRulesHash, InvalidPredictionRulesUri,
    InvalidPredictionTokenOwner, InvalidPredictionVault, PredictionAccountingOverflow,
    PredictionBackingUnderflow, PredictionCreatorMustResolve, PredictionDepositAfterResolution,
    PredictionMergeUnavailable, PredictionNotDraft, PredictionOpeningClosed,
    PredictionPositionMarketMismatch, PredictionPositionOwnerMismatch, PredictionSplitUnavailable,
    PredictionTimestampOverflow, UnauthorizedPredictionAuthority,
};
