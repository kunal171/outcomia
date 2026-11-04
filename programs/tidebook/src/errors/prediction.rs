//! Prediction configuration errors from the stable program-wide error catalog.

pub use super::TidebookError::{
    InvalidPredictionCloseTime, InvalidPredictionFallback, InvalidPredictionPayout,
    InvalidPredictionPriceTick, InvalidPredictionResolutionDelay, InvalidPredictionResolutionTime,
    InvalidPredictionResolver, InvalidPredictionRulesHash, InvalidPredictionRulesUri,
    PredictionTimestampOverflow,
};
