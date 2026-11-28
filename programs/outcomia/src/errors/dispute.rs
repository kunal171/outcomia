//! Outcome dispute errors; append-only codes live in catalog.
pub use super::OutcomiaError::{
    DisputeOpen, DisputeRulingExpired, DisputeRulingNotExpired, DisputeUnavailable,
    DisputeWindowOpen, DisputerHoldsNothing, IneligibleDisputeRuler, InvalidBondRecipient,
    InvalidDisputeConfig, InvalidDisputeRuling, NoOpenDispute,
};
