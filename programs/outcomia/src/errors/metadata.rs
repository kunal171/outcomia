//! Human-readable market metadata validation and ownership errors.

pub use super::OutcomiaError::{
    InvalidMarketDisplayName, InvalidMarketSymbol, MarketMetadataMismatch,
    PredictionMarketUnavailable,
};
