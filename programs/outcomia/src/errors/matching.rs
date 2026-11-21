//! Matching-price, maker-priority, collateral, and self-trade errors.

pub use super::OutcomiaError::{
    InvalidComplementMatch, InvalidMakerCollateral, MakerNotAtBestPrice, MakerNotFifoHead,
    MatchingSameSide, OrdersDoNotCross, SelfTradeNotAllowed,
};
