//! Bounded GraphQL reads over PostgreSQL. Resolvers never call Solana RPC.
use crate::{account_data, auth, charts};
use async_graphql::{
    Context, EmptyMutation, InputObject, Json as GqlJson, Object, Schema, SimpleObject,
    Subscription,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive},
        Sse,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::{Stream, StreamExt};
use serde_json::Value;
use sqlx::{postgres::PgListener, PgPool, Postgres, QueryBuilder, Row};
use std::{convert::Infallible, time::Duration};
use tokio::sync::broadcast;
#[derive(Clone)]
pub struct ApiState {
    pub pool: PgPool,
    pub revisions: broadcast::Sender<String>,
}
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
fn commitment(value: Option<String>) -> async_graphql::Result<String> {
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
pub struct Query;
#[Object]
impl Query {
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
            .push_bind(account_type);
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
    async fn me(&self, ctx: &Context<'_>) -> async_graphql::Result<Option<GqlJson<Value>>> {
        Ok(ctx
            .data::<Option<auth::User>>()?
            .as_ref()
            .map(|user| GqlJson(serde_json::to_value(user).expect("user serializes"))))
    }
    async fn wallet_assets(
        &self,
        ctx: &Context<'_>,
        owner: String,
        commitment: Option<String>,
    ) -> async_graphql::Result<GqlJson<Value>> {
        let state = ctx.data::<ApiState>()?;
        let level = self::commitment(commitment)?;
        let status:Option<(bool,Option<String>)>=sqlx::query_as("SELECT ready AND observed_at>NOW()-INTERVAL '90 seconds',last_error FROM wallet_sync WHERE owner=$1 AND commitment=$2").bind(&owner).bind(&level).fetch_optional(&state.pool).await?;
        let Some((true, _)) = status else {
            return Err(
                "Wallet holdings are warming or stale; sign in to track this wallet".into(),
            );
        };
        let rows=sqlx::query("SELECT mint,token_program,amount::text,frozen::text,decimals,account_count,slot FROM wallet_assets WHERE owner=$1 AND commitment=$2 ORDER BY mint,token_program").bind(owner).bind(level).fetch_all(&state.pool).await?;
        Ok(GqlJson(Value::Array(rows.into_iter().map(|r|serde_json::json!({"mint":r.get::<String,_>("mint"),"tokenProgram":r.get::<String,_>("token_program"),"amount":r.get::<String,_>("amount"),"frozen":r.get::<String,_>("frozen"),"decimals":r.get::<i16,_>("decimals"),"accountCount":r.get::<i32,_>("account_count"),"slot":r.get::<i64,_>("slot").to_string()})).collect())))
    }
    #[graphql(complexity = "500")]
    async fn candles(
        &self,
        ctx: &Context<'_>,
        market: String,
        engine: String,
        outcome: String,
        interval: i32,
        from: String,
        to: String,
    ) -> async_graphql::Result<charts::CandleSeries> {
        charts::query(
            &ctx.data::<ApiState>()?.pool,
            &market,
            &engine,
            &outcome,
            interval,
            &from,
            &to,
        )
        .await
    }
}
#[derive(SimpleObject)]
pub struct Revision {
    pub commitment: String,
    pub revision: String,
    pub resync: bool,
}
pub struct Changes;
#[Subscription]
impl Changes {
    async fn revisions(
        &self,
        ctx: &Context<'_>,
        commitment: Option<String>,
    ) -> impl Stream<Item = Revision> {
        let rx = ctx.data_unchecked::<ApiState>().revisions.subscribe();
        let level = commitment.unwrap_or_else(|| "confirmed".into());
        futures_util::stream::unfold((rx, level), |(mut rx, level)| async move {
            loop {
                match rx.recv().await {
                    Ok(value) => {
                        if let Some((kind, revision)) = value.split_once(':') {
                            if kind == level {
                                let item = Revision {
                                    commitment: level.clone(),
                                    revision: revision.into(),
                                    resync: false,
                                };
                                return Some((item, (rx, level)));
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        return Some((
                            Revision {
                                commitment: level.clone(),
                                revision: "0".into(),
                                resync: true,
                            },
                            (rx, level),
                        ))
                    }
                    Err(_) => return None,
                }
            }
        })
    }
}
type AppSchema = Schema<Query, EmptyMutation, Changes>;
#[derive(Clone)]
struct HttpState {
    schema: AppSchema,
    pool: PgPool,
}
async fn execute(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(request): Json<async_graphql::Request>,
) -> Json<async_graphql::Response> {
    let user = auth::current(&state.pool, &headers).await.unwrap_or(None);
    Json(state.schema.execute(request.data(user)).await)
}
async fn stream(
    State(state): State<HttpState>,
    Json(request): Json<async_graphql::Request>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = state.schema.execute_stream(request).map(|response| {
        Ok(Event::default()
            .json_data(response)
            .expect("GraphQL response"))
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
pub fn router(pool: PgPool, auth: auth::AuthState) -> Router {
    let (revisions, _) = broadcast::channel(64);
    let state = ApiState {
        pool: pool.clone(),
        revisions: revisions.clone(),
    };
    let schema = Schema::build(Query, EmptyMutation, Changes)
        .data(state)
        .limit_depth(8)
        .limit_complexity(2500)
        .finish();
    tokio::spawn(async move {
        loop {
            let result = async {
                let mut listener = PgListener::connect_with(&pool).await?;
                listener.listen("outcomia_revisions").await?;
                while let Ok(message) = listener.recv().await {
                    let _ = revisions.send(message.payload().to_owned());
                }
                Ok::<_, sqlx::Error>(())
            }
            .await;
            if result.is_err() {
                let _ = revisions.send("confirmed:0".into());
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Router::new()
        .route("/graphql", post(execute))
        .route("/graphql/stream", post(stream))
        .route("/health/live", get(|| async { StatusCode::OK }))
        .with_state(HttpState {
            schema,
            pool: auth.pool.clone(),
        })
        .merge(auth::router(auth))
        .layer(DefaultBodyLimit::max(32768))
}
