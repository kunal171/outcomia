use crate::api::ApiState;
use async_graphql::{Context, Json as GqlJson, Object};
use serde_json::Value;
use sqlx::Row;

#[derive(Default)]
pub struct ReceiptsQuery;
#[Object]
impl ReceiptsQuery {
    async fn transaction(
        &self,
        ctx: &Context<'_>,
        signature: String,
    ) -> async_graphql::Result<GqlJson<Value>> {
        if signature.len() > 100 || signature.parse::<solana_signature::Signature>().is_err() {
            return Err("Invalid transaction signature".into());
        }
        let pool = &ctx.data::<ApiState>()?.pool;
        let row=sqlx::query("SELECT t.slot,s.ready AND s.slot>=t.slot AND s.observed_at>NOW()-INTERVAL '90 seconds' AS applied FROM chain_transactions t JOIN account_sync s ON s.commitment='finalized' WHERE t.signature=$1").bind(&signature).fetch_optional(pool).await?;
        if let Some(row) = row {
            if row.get::<bool, _>("applied") {
                return Ok(GqlJson(
                    serde_json::json!({"status":"FINALIZED_INDEXED","slot":row.get::<i64,_>("slot").to_string()}),
                ));
            }
        }
        let row=sqlx::query("SELECT r.slot,r.failed,s.ready AND s.slot>=r.slot AND s.observed_at>NOW()-INTERVAL '90 seconds' AND r.observed_at>NOW()-INTERVAL '90 seconds' AS applied FROM confirmed_receipts r JOIN account_sync s ON s.commitment='confirmed' WHERE r.signature=$1").bind(signature).fetch_optional(pool).await?;
        Ok(GqlJson(match row {
            Some(row) => {
                serde_json::json!({"status":if row.get::<bool,_>("failed") {"FAILED"} else if row.get::<bool,_>("applied") {"CONFIRMED_INDEXED"} else {"PENDING_INDEXING"},"slot":row.get::<i64,_>("slot").to_string()})
            }
            None => serde_json::json!({"status":"PENDING_INDEXING","slot":null}),
        }))
    }
}
