//! Durable forward progress for finalized live ingestion.

use solana_pubkey::Pubkey;
use solana_signature::{ParseSignatureError, Signature};
use sqlx::PgPool;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpdateDecision {
    Keep,
    Replace,
}

/// Newest finalized transaction completely persisted by live synchronization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveCheckpoint {
    /// Signature used as the `until` cursor during reconnect catch-up.
    pub signature: Signature,

    /// Finalized slot used to prevent accidental backward movement.
    pub slot: u64,

    /// Optional execution position for deterministic same-slot ordering.
    pub transaction_index: Option<u32>,
}

/// Failures while loading or decoding durable live progress.
#[derive(Debug, Error)]
pub enum LiveCheckpointError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),

    #[error("stored live checkpoint signature is invalid")]
    InvalidSignature(#[from] ParseSignatureError),

    #[error("stored live checkpoint slot {slot} is negative")]
    NegativeSlot { slot: i64 },

    #[error("stored transaction index {transaction_index} is negative")]
    NegativeTransactionIndex { transaction_index: i32 },

    #[error("live checkpoint slot {slot} exceeds PostgreSQL BIGINT range")]
    SlotOutOfRange { slot: u64 },

    #[error(
        "live checkpoint transaction index {transaction_index} \
        exceeds PostgreSQL INTEGER range"
    )]
    TransactionIndexOutOfRange { transaction_index: u32 },

    #[error(
        "live checkpoint attempted to move backward: \
        stored={stored:?}, incoming={incoming:?}"
    )]
    Backward {
        stored: Box<LiveCheckpoint>,
        incoming: Box<LiveCheckpoint>,
    },

    #[error(
        "live checkpoint ordering is ambiguous within one slot: \
        stored={stored:?}, incoming={incoming:?}"
    )]
    AmbiguousSameSlot {
        stored: Box<LiveCheckpoint>,
        incoming: Box<LiveCheckpoint>,
    },

    #[error(
        "live checkpoint position conflicts with existing data: \
        stored={stored:?}, incoming={incoming:?}"
    )]
    PositionConflict {
        stored: Box<LiveCheckpoint>,
        incoming: Box<LiveCheckpoint>,
    },
}

#[derive(Debug, sqlx::FromRow)]
struct LiveCheckpointRow {
    latest_finalized_signature: String,
    latest_finalized_slot: i64,
    transaction_index: Option<i32>,
}

impl TryFrom<LiveCheckpointRow> for LiveCheckpoint {
    type Error = LiveCheckpointError;

    fn try_from(row: LiveCheckpointRow) -> Result<Self, Self::Error> {
        let signature = row.latest_finalized_signature.parse::<Signature>()?;

        let slot = u64::try_from(row.latest_finalized_slot).map_err(|_| {
            LiveCheckpointError::NegativeSlot {
                slot: row.latest_finalized_slot,
            }
        })?;

        let transaction_index = row
            .transaction_index
            .map(|index| {
                u32::try_from(index).map_err(|_| LiveCheckpointError::NegativeTransactionIndex {
                    transaction_index: index,
                })
            })
            .transpose()?;

        Ok(Self {
            signature,
            slot,
            transaction_index,
        })
    }
}

/// Loads the newest completely persisted live position.
///
/// `None` means live synchronization has not yet established its initial
/// high-water mark.
pub async fn load_live_checkpoint(
    pool: &PgPool,
    program_id: &Pubkey,
) -> Result<Option<LiveCheckpoint>, LiveCheckpointError> {
    let row = sqlx::query_as::<_, LiveCheckpointRow>(
        r#"
        SELECT
            latest_finalized_signature,
            latest_finalized_slot,
            transaction_index
        FROM live_checkpoints
        WHERE program_id = $1
        "#,
    )
    .bind(program_id.to_string())
    .fetch_optional(pool)
    .await?;

    row.map(LiveCheckpoint::try_from).transpose()
}

/// Loads the newest transaction already present in append-only source storage.
///
/// This position bootstraps live synchronization after historical backfill has
/// completed but before a dedicated live checkpoint exists. Known transaction
/// indices sort ahead of missing metadata within the newest slot. The
/// signature provides a deterministic final tie-breaker and an exact RPC
/// `until` boundary.
pub async fn load_latest_source_position(
    pool: &PgPool,
) -> Result<Option<LiveCheckpoint>, LiveCheckpointError> {
    let row = sqlx::query_as::<_, LiveCheckpointRow>(
        r#"
        SELECT
            signature AS latest_finalized_signature,
            slot AS latest_finalized_slot,
            transaction_index
        FROM chain_transactions
        ORDER BY
            slot DESC,
            transaction_index DESC NULLS LAST,
            signature DESC
        LIMIT 1
        "#,
    )
    .fetch_optional(pool)
    .await?;

    row.map(LiveCheckpoint::try_from).transpose()
}

fn decide_update(
    stored: &LiveCheckpoint,
    incoming: &LiveCheckpoint,
) -> Result<UpdateDecision, LiveCheckpointError> {
    // The same signature identifies one immutable transaction. A newly
    // available transaction index may enrich it, but its position cannot move.
    if stored.signature == incoming.signature {
        let conflicting_index = matches!(
            (stored.transaction_index, incoming.transaction_index),
            (Some(stored_index), Some(incoming_index))
                if stored_index != incoming_index
        );

        if stored.slot != incoming.slot || conflicting_index {
            return Err(LiveCheckpointError::PositionConflict {
                stored: Box::new(stored.clone()),
                incoming: Box::new(incoming.clone()),
            });
        }

        return Ok(
            if stored.transaction_index.is_none() && incoming.transaction_index.is_some() {
                UpdateDecision::Replace
            } else {
                // Exact replay, or a replay missing metadata already stored.
                UpdateDecision::Keep
            },
        );
    }

    match incoming.slot.cmp(&stored.slot) {
        std::cmp::Ordering::Greater => Ok(UpdateDecision::Replace),

        std::cmp::Ordering::Less => Err(LiveCheckpointError::Backward {
            stored: Box::new(stored.clone()),
            incoming: Box::new(incoming.clone()),
        }),

        std::cmp::Ordering::Equal => match (stored.transaction_index, incoming.transaction_index) {
            (Some(stored_index), Some(incoming_index)) if incoming_index > stored_index => {
                Ok(UpdateDecision::Replace)
            }

            (Some(stored_index), Some(incoming_index)) if incoming_index < stored_index => {
                Err(LiveCheckpointError::Backward {
                    stored: Box::new(stored.clone()),
                    incoming: Box::new(incoming.clone()),
                })
            }

            (Some(_), Some(_)) => Err(LiveCheckpointError::PositionConflict {
                stored: Box::new(stored.clone()),
                incoming: Box::new(incoming.clone()),
            }),

            _ => Err(LiveCheckpointError::AmbiguousSameSlot {
                stored: Box::new(stored.clone()),
                incoming: Box::new(incoming.clone()),
            }),
        },
    }
}

/// Inserts or advances the durable live checkpoint without allowing regression.
///
/// A transaction-scoped advisory lock serializes writers even when the program
/// has no checkpoint row yet. A row lock alone cannot protect that initial
/// missing-row case.
pub async fn save_live_checkpoint(
    pool: &PgPool,
    program_id: &Pubkey,
    incoming: &LiveCheckpoint,
) -> Result<(), LiveCheckpointError> {
    // Perform fallible conversions before opening the database transaction.
    let slot = i64::try_from(incoming.slot).map_err(|_| LiveCheckpointError::SlotOutOfRange {
        slot: incoming.slot,
    })?;

    let transaction_index = incoming
        .transaction_index
        .map(|index| {
            i32::try_from(index).map_err(|_| LiveCheckpointError::TransactionIndexOutOfRange {
                transaction_index: index,
            })
        })
        .transpose()?;

    let program_id = program_id.to_string();
    let signature = incoming.signature.to_string();
    let mut transaction = pool.begin().await?;

    // Hash collisions only serialize unrelated programs; they cannot weaken
    // correctness. The lock lasts until this database transaction finishes.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&program_id)
        .execute(&mut *transaction)
        .await?;

    let stored_row = sqlx::query_as::<_, LiveCheckpointRow>(
        r#"
        SELECT
            latest_finalized_signature,
            latest_finalized_slot,
            transaction_index
        FROM live_checkpoints
        WHERE program_id = $1
        FOR UPDATE
        "#,
    )
    .bind(&program_id)
    .fetch_optional(&mut *transaction)
    .await?;

    match stored_row {
        None => {
            sqlx::query(
                r#"
                INSERT INTO live_checkpoints (
                    program_id,
                    latest_finalized_signature,
                    latest_finalized_slot,
                    transaction_index
                )
                VALUES ($1, $2, $3, $4)
                "#,
            )
            .bind(&program_id)
            .bind(&signature)
            .bind(slot)
            .bind(transaction_index)
            .execute(&mut *transaction)
            .await?;
        }

        Some(row) => {
            let stored = LiveCheckpoint::try_from(row)?;

            if decide_update(&stored, incoming)? == UpdateDecision::Replace {
                sqlx::query(
                    r#"
                    UPDATE live_checkpoints
                    SET latest_finalized_signature = $2,
                        latest_finalized_slot = $3,
                        transaction_index = $4,
                        updated_at = NOW()
                    WHERE program_id = $1
                    "#,
                )
                .bind(&program_id)
                .bind(&signature)
                .bind(slot)
                .bind(transaction_index)
                .execute(&mut *transaction)
                .await?;
            }
        }
    }

    transaction.commit().await?;

    Ok(())
}

/// Loads durable live progress or bootstraps it from persisted source data.
///
/// Existing live progress always wins. Source storage may be ahead when the
/// process crashed after persisting a transaction but before checkpointing it;
/// starting from the older checkpoint allows that transaction to replay safely.
pub async fn load_or_initialize_live_checkpoint(
    pool: &PgPool,
    program_id: &Pubkey,
) -> Result<Option<LiveCheckpoint>, LiveCheckpointError> {
    if let Some(checkpoint) = load_live_checkpoint(pool, program_id).await? {
        return Ok(Some(checkpoint));
    }

    let Some(source_position) = load_latest_source_position(pool).await? else {
        return Ok(None);
    };

    save_live_checkpoint(pool, program_id, &source_position).await?;

    Ok(Some(source_position))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint(signature_byte: u8, slot: u64, index: Option<u32>) -> LiveCheckpoint {
        LiveCheckpoint {
            signature: Signature::from([signature_byte; 64]),
            slot,
            transaction_index: index,
        }
    }

    async fn insert_source_position(pool: &PgPool, position: &LiveCheckpoint) {
        sqlx::query(
            r#"
            INSERT INTO chain_transactions (
                signature,
                slot,
                transaction_index,
                raw_logs
            )
            VALUES ($1, $2, $3, '[]'::jsonb)
            "#,
        )
        .bind(position.signature.to_string())
        .bind(i64::try_from(position.slot).expect("test slot must fit BIGINT"))
        .bind(
            position
                .transaction_index
                .map(|index| i32::try_from(index).expect("test index must fit INTEGER")),
        )
        .execute(pool)
        .await
        .expect("source-position insert must succeed");
    }

    #[test]
    fn update_decision_enriches_same_signature_without_allowing_position_changes() {
        let stored = checkpoint(1, 10, None);
        let enriched = checkpoint(1, 10, Some(2));

        assert_eq!(
            decide_update(&stored, &enriched).expect("missing index may be enriched"),
            UpdateDecision::Replace
        );
        assert_eq!(
            decide_update(&enriched, &stored).expect("missing replay metadata must not downgrade"),
            UpdateDecision::Keep
        );

        assert!(matches!(
            decide_update(&enriched, &checkpoint(1, 11, Some(2))),
            Err(LiveCheckpointError::PositionConflict { .. })
        ));
        assert!(matches!(
            decide_update(&enriched, &checkpoint(1, 10, Some(3))),
            Err(LiveCheckpointError::PositionConflict { .. })
        ));
    }

    #[test]
    fn update_decision_orders_different_signatures_fail_closed() {
        let stored = checkpoint(1, 10, Some(2));

        assert_eq!(
            decide_update(&stored, &checkpoint(2, 11, None)).expect("higher slot must advance"),
            UpdateDecision::Replace
        );
        assert_eq!(
            decide_update(&stored, &checkpoint(2, 10, Some(3)))
                .expect("higher same-slot index must advance"),
            UpdateDecision::Replace
        );
        assert!(matches!(
            decide_update(&stored, &checkpoint(2, 9, Some(9))),
            Err(LiveCheckpointError::Backward { .. })
        ));
        assert!(matches!(
            decide_update(&stored, &checkpoint(2, 10, None)),
            Err(LiveCheckpointError::AmbiguousSameSlot { .. })
        ));
        assert!(matches!(
            decide_update(&stored, &checkpoint(2, 10, Some(2))),
            Err(LiveCheckpointError::PositionConflict { .. })
        ));
    }

    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires a PostgreSQL server supplied through DATABASE_URL"]
    async fn live_checkpoint_saves_idempotently_and_rejects_regression(pool: PgPool) {
        let program_id = Pubkey::new_from_array([21; 32]);
        let initial = checkpoint(1, 10, None);

        save_live_checkpoint(&pool, &program_id, &initial)
            .await
            .expect("initial checkpoint insert must succeed");
        save_live_checkpoint(&pool, &program_id, &initial)
            .await
            .expect("exact replay must succeed");

        let enriched = checkpoint(1, 10, Some(2));
        save_live_checkpoint(&pool, &program_id, &enriched)
            .await
            .expect("same-signature metadata enrichment must succeed");

        let same_slot_advance = checkpoint(2, 10, Some(3));
        save_live_checkpoint(&pool, &program_id, &same_slot_advance)
            .await
            .expect("higher same-slot index must advance");

        assert!(matches!(
            save_live_checkpoint(&pool, &program_id, &checkpoint(3, 10, Some(2))).await,
            Err(LiveCheckpointError::Backward { .. })
        ));
        assert!(matches!(
            save_live_checkpoint(&pool, &program_id, &checkpoint(3, 10, None)).await,
            Err(LiveCheckpointError::AmbiguousSameSlot { .. })
        ));

        let higher_slot = checkpoint(4, 11, None);
        save_live_checkpoint(&pool, &program_id, &higher_slot)
            .await
            .expect("higher slot must advance without an index");

        let stored = load_live_checkpoint(&pool, &program_id)
            .await
            .expect("checkpoint load must succeed")
            .expect("checkpoint must exist");

        assert_eq!(stored, higher_slot);
    }

    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires a PostgreSQL server supplied through DATABASE_URL"]
    async fn latest_source_position_prefers_slot_then_known_transaction_index(pool: PgPool) {
        assert_eq!(
            load_latest_source_position(&pool)
                .await
                .expect("empty source-position load must succeed"),
            None
        );

        let candidates = [
            checkpoint(1, 10, Some(9)),
            checkpoint(2, 11, None),
            checkpoint(3, 11, Some(2)),
            checkpoint(4, 11, Some(3)),
        ];

        for candidate in &candidates {
            insert_source_position(&pool, candidate).await;
        }

        let latest = load_latest_source_position(&pool)
            .await
            .expect("source-position load must succeed")
            .expect("source position must exist");

        assert_eq!(latest, candidates[3]);
    }

    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires a PostgreSQL server supplied through DATABASE_URL"]
    async fn checkpoint_bootstrap_returns_none_when_source_storage_is_empty(pool: PgPool) {
        let program_id = Pubkey::new_from_array([31; 32]);

        let checkpoint = load_or_initialize_live_checkpoint(&pool, &program_id)
            .await
            .expect("empty checkpoint bootstrap must succeed");

        assert_eq!(checkpoint, None);
        assert_eq!(
            load_live_checkpoint(&pool, &program_id)
                .await
                .expect("checkpoint verification load must succeed"),
            None
        );
    }

    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires a PostgreSQL server supplied through DATABASE_URL"]
    async fn checkpoint_bootstrap_persists_latest_source_position(pool: PgPool) {
        let program_id = Pubkey::new_from_array([32; 32]);
        let source_position = checkpoint(5, 20, Some(4));
        insert_source_position(&pool, &source_position).await;

        let initialized = load_or_initialize_live_checkpoint(&pool, &program_id)
            .await
            .expect("source checkpoint bootstrap must succeed");

        assert_eq!(initialized, Some(source_position.clone()));
        assert_eq!(
            load_live_checkpoint(&pool, &program_id)
                .await
                .expect("persisted checkpoint load must succeed"),
            Some(source_position)
        );
    }

    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires a PostgreSQL server supplied through DATABASE_URL"]
    async fn checkpoint_bootstrap_preserves_existing_older_progress(pool: PgPool) {
        let program_id = Pubkey::new_from_array([33; 32]);
        let existing = checkpoint(6, 20, Some(4));
        let newer_source = checkpoint(7, 21, Some(0));

        insert_source_position(&pool, &newer_source).await;
        save_live_checkpoint(&pool, &program_id, &existing)
            .await
            .expect("existing checkpoint setup must succeed");

        let loaded = load_or_initialize_live_checkpoint(&pool, &program_id)
            .await
            .expect("existing checkpoint bootstrap must succeed");

        assert_eq!(loaded, Some(existing.clone()));
        assert_eq!(
            load_live_checkpoint(&pool, &program_id)
                .await
                .expect("existing checkpoint verification load must succeed"),
            Some(existing)
        );
    }
}
