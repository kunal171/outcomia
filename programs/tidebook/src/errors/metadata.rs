//! Human-readable market metadata validation and ownership errors.

pub use super::TidebookError::{
    InvalidMarketDisplayName, InvalidMarketSymbol, MarketMetadataMismatch,
    PredictionMarketUnavailable,
};
