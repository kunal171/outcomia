use crate::account_data;
use crate::api::ApiState;
use async_graphql::{Context, Json as GqlJson, Object};
use async_graphql::{InputObject, SimpleObject};
use serde_json::Value;
use sqlx::Row;
use sqlx::{Postgres, QueryBuilder};
#[derive(SimpleObject)]
pub struct SyncInfo {
    pub commitment: String,
    pub slot: String,
    pub revision: String,
    pub ready: bool,
    pub observed_at: Option<String>,
    pub error: Option<String>,
}
#[derive(SimpleObject)]
pub struct IndexedAccount {
    pub address: String,
    pub account_type: String,
    pub data: GqlJson<Value>,
    pub raw_base64: String,
    pub lamports: String,
    pub slot: String,
    pub revision: String,
}
#[derive(SimpleObject)]
pub struct AccountPage {
    pub nodes: Vec<IndexedAccount>,
    pub sync: SyncInfo,
    pub has_next_page: bool,
    pub end_cursor: Option<String>,
}
#[derive(InputObject, Clone)]
pub struct Memcmp {
    pub offset: i32,
    pub bytes: String,
}
pub(super) fn commitment(value: Option<String>) -> async_graphql::Result<String> {
    let value = value.unwrap_or_else(|| "confirmed".into());
    if !matches!(value.as_str(), "confirmed" | "finalized") {
        return Err("Use confirmed or finalized commitment".into());
    }
    Ok(value)
}
async fn sync(conn: &mut sqlx::PgConnection, level: &str) -> async_graphql::Result<SyncInfo> {
    let row=sqlx::query("SELECT *, (EXTRACT(EPOCH FROM observed_at)::bigint)::text AS observed, ready AND observed_at>NOW()-INTERVAL '90 seconds' AS fresh FROM account_sync WHERE commitment=$1").bind(level).fetch_one(conn).await?;
    Ok(SyncInfo {
        commitment: level.into(),
        slot: row.get::<i64, _>("slot").to_string(),
        revision: row.get::<i64, _>("revision").to_string(),
        ready: row.get("fresh"),
        observed_at: row.get("observed"),
        error: row.get("last_error"),
    })
}
fn account(row: sqlx::postgres::PgRow) -> IndexedAccount {
    IndexedAccount {
        address: row.get("address"),
        account_type: row.get("account_type"),
        data: GqlJson(row.get("data")),
        raw_base64: row.get("raw_base64"),
        lamports: row.get("atoms"),
        slot: row.get::<i64, _>("slot").to_string(),
        revision: row.get::<i64, _>("revision").to_string(),
    }
}

#[derive(Default)]
pub struct AccountsQuery;
#[Object]
impl AccountsQuery {
    async fn sync_status(
        &self,
        ctx: &Context<'_>,
        commitment: Option<String>,
    ) -> async_graphql::Result<SyncInfo> {
        let state = ctx.data::<ApiState>()?;
        let mut conn = state.pool.acquire().await?;
        sync(&mut conn, &self::commitment(commitment)?).await
    }

    async fn account(
        &self,
        ctx: &Context<'_>,
        address: String,
        commitment: Option<String>,
    ) -> async_graphql::Result<Option<IndexedAccount>> {
        if address.len() > 64 {
            return Err("Invalid account address".into());
        }
        let state = ctx.data::<ApiState>()?;
        let level = self::commitment(commitment)?;
        let mut tx = state.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;
        if !sync(&mut tx, &level).await?.ready {
            return Err("Account index is warming or stale".into());
        }
        let row=sqlx::query("SELECT *,lamports::text AS atoms FROM indexed_accounts WHERE commitment=$1 AND address=$2 AND NOT deleted").bind(level).bind(address).fetch_optional(&mut *tx).await?;
        tx.commit().await?;
        Ok(row.map(account))
    }

    // Independent GraphQL filters are part of the public query contract.
    #[allow(clippy::too_many_arguments)]
    #[graphql(complexity = "500")]
    async fn accounts(
        &self,
        ctx: &Context<'_>,
        account_type: String,
        filters: Option<Vec<Memcmp>>,
        after: Option<String>,
        first: Option<i32>,
        commitment: Option<String>,
        revision: Option<String>,
    ) -> async_graphql::Result<AccountPage> {
        if !account_data::idl()["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["name"] == account_type)
        {
            return Err("Unsupported account type".into());
        }
        let first = first.unwrap_or(100);
        if !(1..=500).contains(&first) || after.as_ref().is_some_and(|v| v.len() > 64) {
            return Err("Invalid account page bounds".into());
        }
        let filters = filters.unwrap_or_default();
        if filters.len() > 4 {
            return Err("Too many account filters".into());
        }
        let state = ctx.data::<ApiState>()?;
        let level = self::commitment(commitment)?;
        let mut tx = state.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;
        let status = sync(&mut tx, &level).await?;
        if !status.ready {
            return Err("Account index is warming or stale".into());
        }
        if revision.is_some_and(|r| r != status.revision) {
            return Err("Account revision changed; reload pagination".into());
        }
        let mut sql=QueryBuilder::<Postgres>::new("SELECT *,lamports::text AS atoms FROM indexed_accounts WHERE NOT deleted AND commitment=");
        sql.push_bind(level)
            .push(" AND account_type=")
            .push_bind(account_type.clone());
        if let Some(after) = after {
            sql.push(" AND address>").push_bind(after);
        }
        for filter in filters {
            if !(0..=131072).contains(&filter.offset) || filter.bytes.len() > 256 {
                return Err("Invalid account filter".into());
            }
            let bytes = bs58::decode(filter.bytes)
                .into_vec()
                .map_err(|_| async_graphql::Error::new("Invalid filter encoding"))?;
            if bytes.is_empty() || bytes.len() > 128 {
                return Err("Invalid account filter length".into());
            }
            if let Some(field) =
                account_data::indexed_filter_field(&account_type, filter.offset, bytes.len())
            {
                sql.push(format!(" AND data->>'{field}'="))
                    .push_bind(bs58::encode(bytes).into_string());
                continue;
            }
            sql.push(" AND substring(decode(raw_base64,'base64') FROM ")
                .push_bind(filter.offset + 1)
                .push(" FOR ")
                .push_bind(bytes.len() as i32)
                .push(")=")
                .push_bind(bytes);
        }
        sql.push(" ORDER BY address LIMIT ").push_bind(first + 1);
        let mut rows = sql.build().fetch_all(&mut *tx).await?;
        tx.commit().await?;
        let has_next_page = rows.len() > first as usize;
        rows.truncate(first as usize);
        let nodes: Vec<_> = rows.into_iter().map(account).collect();
        let end_cursor = nodes.last().map(|n| n.address.clone());
        Ok(AccountPage {
            nodes,
            sync: status,
            has_next_page,
            end_cursor,
        })
    }

    async fn raw_accounts(
        &self,
        ctx: &Context<'_>,
        addresses: Vec<String>,
    ) -> async_graphql::Result<GqlJson<Value>> {
        if addresses.len() > 100 || addresses.iter().any(|k| k.len() > 64) {
            return Err("Too many account addresses".into());
        }
        let state = ctx.data::<ApiState>()?;
        let mut tx = state.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;
        if !sync(&mut tx, "confirmed").await?.ready {
            return Err("Account index is warming or stale".into());
        }
        let program: Option<String> =
            sqlx::query_scalar("SELECT program_id FROM indexer_identity WHERE singleton")
                .fetch_optional(&mut *tx)
                .await?;
        let rows=sqlx::query("SELECT address,raw_base64,lamports::text AS lamports,$2::text AS owner FROM indexed_accounts WHERE commitment='confirmed' AND NOT deleted AND address=ANY($1) UNION ALL SELECT address,raw_base64,'0',owner FROM mint_cache WHERE address=ANY($1)").bind(&addresses).bind(program.unwrap_or_default()).fetch_all(&mut *tx).await?;
        let mapped:std::collections::HashMap<String,Value>=rows.into_iter().map(|r| (r.get("address"),serde_json::json!({"rawBase64":r.get::<String,_>("raw_base64"),"lamports":r.get::<String,_>("lamports"),"owner":r.get::<String,_>("owner")}))).collect();
        tx.commit().await?;
        Ok(GqlJson(Value::Array(
            addresses
                .iter()
                .map(|a| mapped.get(a).cloned().unwrap_or(Value::Null))
                .collect(),
        )))
    }
}
