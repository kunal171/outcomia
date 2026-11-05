//! Prediction configuration errors from the stable program-wide error catalog.

pub use super::TidebookError::{
    InsufficientPredictionPositions, InvalidPredictionCloseTime, InvalidPredictionCollateralMint,
    InvalidPredictionContractQuantity, InvalidPredictionFallback, InvalidPredictionOrderId,
    InvalidPredictionOrderNeighbor, InvalidPredictionOrderPrice, InvalidPredictionPayout,
    InvalidPredictionPriceLevel, InvalidPredictionPriceTick, InvalidPredictionRentRecipient,
    InvalidPredictionResolutionDelay, InvalidPredictionResolutionTime, InvalidPredictionResolver,
    InvalidPredictionRulesHash, InvalidPredictionRulesUri, InvalidPredictionTail,
    InvalidPredictionTokenOwner, InvalidPredictionVault, PredictionAccountingOverflow,
    PredictionBackingUnderflow, PredictionBookMarketMismatch, PredictionCreatorMustResolve,
    PredictionDepositAfterResolution, PredictionMergeUnavailable, PredictionNotDraft,
    PredictionOpeningClosed, PredictionOrderAccountingMismatch, PredictionOrderNotOpen,
    PredictionOrderUnavailable, PredictionOrderWouldCross, PredictionPositionMarketMismatch,
    PredictionPositionOwnerMismatch, PredictionSideNotEmpty, PredictionSplitUnavailable,
    PredictionTimestampOverflow, UnauthorizedPredictionAuthority, UnauthorizedPredictionOrderOwner,
};
