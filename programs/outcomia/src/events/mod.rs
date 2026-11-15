//! Events emitted by successful Outcomia state transitions.
//!
//! Events are an observation API, not protocol state. Consumers must process
//! them only from successful transactions because failed transactions can
//! retain diagnostic logs even though every account mutation was rolled back.

mod admin;
mod balance;
mod faucet;
mod fee;
mod fill;
mod market;
mod metadata;
mod order;

pub use admin::*;
pub use balance::*;
pub use faucet::*;
pub use fee::*;
pub use fill::*;
pub use market::*;
pub use metadata::*;
pub use order::*;

mod multi_outcome;
pub use multi_outcome::*;
