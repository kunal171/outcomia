//! Domain-oriented access to Outcomia's stable Anchor error catalog.
//!
//! Anchor 1.2 accepts only one `#[error_code]` enum when generating an IDL.
//! `catalog` therefore owns the ABI, while each public domain module re-exports
//! only the variants relevant to that service.

pub mod admin;
pub mod balance;
pub mod faucet;
pub mod fee;
pub mod market;
pub mod matching;
pub mod metadata;
pub mod multi_outcome;
pub mod order;
pub mod prediction;
pub mod shared;

mod catalog;

pub use catalog::OutcomiaError;
