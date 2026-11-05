//! Prediction configuration errors from the stable program-wide error catalog.

pub use super::TidebookError::{
    InsufficientPredictionPositions, InvalidPredictionCloseTime, InvalidPredictionCollateralMint,
    InvalidPredictionContractQuantity, InvalidPredictionFallback, InvalidPredictionOrderId,
    InvalidPredictionOrderPrice, InvalidPredictionPayout, InvalidPredictionPriceLevel,
    InvalidPredictionPriceTick, InvalidPredictionResolutionDelay, InvalidPredictionResolutionTime,
    InvalidPredictionResolver, InvalidPredictionRulesHash, InvalidPredictionRulesUri,
    InvalidPredictionTail, InvalidPredictionTokenOwner, InvalidPredictionVault,
    PredictionAccountingOverflow, PredictionBackingUnderflow, PredictionBookMarketMismatch,
    PredictionCreatorMustResolve, PredictionDepositAfterResolution, PredictionMergeUnavailable,
    PredictionNotDraft, PredictionOpeningClosed, PredictionOrderUnavailable,
    PredictionOrderWouldCross, PredictionPositionMarketMismatch, PredictionPositionOwnerMismatch,
    PredictionSideNotEmpty, PredictionSplitUnavailable, PredictionTimestampOverflow,
    UnauthorizedPredictionAuthority,
};
