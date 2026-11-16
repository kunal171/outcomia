//! Cache immutable classic SPL mint precision once, shared by all readers.
use crate::account_store::Snapshot;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::request::RpcRequest;
use sqlx::PgPool;
use std::{collections::BTreeSet, error::Error, sync::Arc};
pub const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub async fn observe(
    pool: &PgPool,
    client: Arc<RpcClient>,
    snapshot: &Snapshot,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let mut keys = BTreeSet::new();
    for row in &snapshot.rows {
        for field in ["mint", "baseMint", "quoteMint", "collateralMint"] {
            if let Some(key) = row.data[field].as_str() {
                if key != "11111111111111111111111111111111" {
                    keys.insert(key.to_owned());
                }
            }
        }
    }
    ensure(pool, client, keys.into_iter().collect(), snapshot.slot).await
}
pub async fn ensure(
    pool: &PgPool,
    client: Arc<RpcClient>,
    keys: Vec<String>,
    min_slot: i64,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let known: Vec<String> =
        sqlx::query_scalar("SELECT address FROM mint_cache WHERE address=ANY($1)")
            .bind(&keys)
            .fetch_all(pool)
            .await?;
    let missing: Vec<_> = keys.into_iter().filter(|k| !known.contains(k)).collect();
    for batch in missing.chunks(100) {
        let addresses = batch.to_vec();
        let rpc = Arc::clone(&client);
        let slot = min_slot;
        let response:Value=tokio::task::spawn_blocking(move ||rpc.send(RpcRequest::GetMultipleAccounts,json!([addresses,{"encoding":"base64","commitment":"confirmed","minContextSlot":slot}]))).await??;
        let rows = response["value"]
            .as_array()
            .ok_or("missing mint response")?;
        if rows.len() != batch.len() {
            return Err("incomplete mint response".into());
        }
        for (address, row) in batch.iter().zip(rows) {
            let raw = row["data"][0].as_str().ok_or("mint not found")?;
            let bytes = STANDARD.decode(raw)?;
            if row["owner"] != TOKEN || bytes.len() != 82 || bytes[45] != 1 {
                return Err("unsupported or uninitialized mint".into());
            }
            sqlx::query("INSERT INTO mint_cache(address,owner,raw_base64,decimals) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING").bind(address).bind(TOKEN).bind(raw).bind(i16::from(bytes[44])).execute(pool).await?;
        }
    }
    Ok(())
}
