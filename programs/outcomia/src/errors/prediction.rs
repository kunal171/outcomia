//! Prediction configuration errors from the stable program-wide error catalog.

pub use super::OutcomiaError::{
    InsufficientPredictionPositions, InvalidPredictionCloseTime, InvalidPredictionCollateralMint,
    InvalidPredictionContractQuantity, InvalidPredictionFallback, InvalidPredictionOrderId,
    InvalidPredictionOrderNeighbor, InvalidPredictionOrderPrice, InvalidPredictionPayout,
    InvalidPredictionPriceLevel, InvalidPredictionPriceTick, InvalidPredictionRentRecipient,
    InvalidPredictionResolutionDelay, InvalidPredictionResolutionTime, InvalidPredictionResolver,
    InvalidPredictionRulesHash, InvalidPredictionRulesUri, InvalidPredictionTail,
    InvalidPredictionTokenOwner, InvalidPredictionVault, PredictionAccountingOverflow,
    PredictionBackingUnderflow, PredictionBookMarketMismatch, PredictionCreatorMustResolve,
    PredictionDepositAfterResolution, PredictionMakerNotBest, PredictionMakerNotHead,
    PredictionMatchingSameSide, PredictionMergeUnavailable, PredictionNotDraft,
    PredictionOpeningClosed, PredictionOrderAccountingMismatch, PredictionOrderNotOpen,
    PredictionOrderUnavailable, PredictionOrderWouldCross, PredictionOrdersDoNotCross,
    PredictionPositionMarketMismatch, PredictionPositionOwnerMismatch, PredictionSelfTrade,
    PredictionSideNotEmpty, PredictionSplitUnavailable, PredictionTimestampOverflow,
    UnauthorizedPredictionAuthority, UnauthorizedPredictionOrderOwner,
};
