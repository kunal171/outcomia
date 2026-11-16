use crate::api::ApiState;
use async_graphql::{Context, Json as GqlJson, Object};
use serde_json::Value;
use sqlx::Row;

#[derive(Default)]
pub struct MarketsQuery;
#[Object]
impl MarketsQuery {
    async fn latest_trade(
        &self,
        ctx: &Context<'_>,
        market: String,
        engine: String,
    ) -> async_graphql::Result<Option<GqlJson<Value>>> {
        if market.len() > 64 || engine.len() > 32 {
            return Err("Invalid trade filters".into());
        }
        let row=sqlx::query("SELECT price::text,signature,block_time::text FROM indexed_trades WHERE market=$1 AND engine=$2 ORDER BY slot DESC,transaction_index DESC NULLS LAST,execution_index DESC LIMIT 1").bind(market).bind(engine).fetch_optional(&ctx.data::<ApiState>()?.pool).await?;
        Ok(row.map(|r|GqlJson(serde_json::json!({"price":r.get::<String,_>("price"),"signature":r.get::<String,_>("signature"),"blockTime":r.get::<Option<String>,_>("block_time")}))))
    }
}
