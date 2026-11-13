//! Multi-outcome validation/accounting errors; append-only codes live in catalog.
pub use super::OutcomiaError::{
    InvalidMultiOutcomeCount, InvalidMultiOutcomeId, InvalidMultiOutcomeLabel,
    InvalidMultiOutcomeLot, InvalidMultiOutcomePayout, InvalidMultiOutcomePrice,
    MultiOutcomeAccountingOverflow, MultiOutcomeInactiveSlot, MultiOutcomeSupplyMismatch,
};
