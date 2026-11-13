//! Multi-outcome validation/accounting errors; append-only codes live in catalog.
pub use super::OutcomiaError::{
    InvalidMultiOutcomeBook, InvalidMultiOutcomeCount, InvalidMultiOutcomeId,
    InvalidMultiOutcomeLabel, InvalidMultiOutcomeLot, InvalidMultiOutcomePayout,
    InvalidMultiOutcomePosition, InvalidMultiOutcomePrice, MultiOutcomeAccountingOverflow,
    MultiOutcomeBookFull, MultiOutcomeFeeQuoteChanged, MultiOutcomeInactiveSlot,
    MultiOutcomeReserveMismatch, MultiOutcomeSupplyMismatch,
};
