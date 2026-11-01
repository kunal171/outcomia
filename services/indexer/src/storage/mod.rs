//! Durable PostgreSQL storage for finalized source records and sync progress.

mod checkpoint;
mod connection;
mod live_checkpoint;
mod models;
mod writer;

pub use checkpoint::{load_backfill_checkpoint, save_backfill_checkpoint};
pub use connection::connect;
// The staged live APIs are exposed before startup consumes all of them. Remove
// this narrow allowance when checkpoint bootstrap and catch-up are wired.
#[allow(
    unused_imports,
    reason = "staged live-checkpoint APIs are consumed by the next milestone"
)]
pub use live_checkpoint::{
    load_latest_source_position,load_or_initialize_live_checkpoint, load_live_checkpoint, save_live_checkpoint, LiveCheckpoint,
};
pub use writer::persist_transaction;
