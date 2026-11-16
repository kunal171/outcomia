use crate::api::ApiState;
use crate::auth;
use async_graphql::{Context, Json as GqlJson, Object};
use serde_json::Value;
use sqlx::Row;

#[derive(Default)]
pub struct WalletQuery;
#[Object]
impl WalletQuery {
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
        let level = super::accounts::commitment(commitment)?;
        let status:Option<(bool,Option<String>)>=sqlx::query_as("SELECT ready AND observed_at>NOW()-INTERVAL '90 seconds',last_error FROM wallet_sync WHERE owner=$1 AND commitment=$2").bind(&owner).bind(&level).fetch_optional(&state.pool).await?;
        let Some((true, _)) = status else {
            return Err(
                "Wallet holdings are warming or stale; sign in to track this wallet".into(),
            );
        };
        let rows=sqlx::query("SELECT mint,token_program,amount::text,frozen::text,decimals,account_count,slot FROM wallet_assets WHERE owner=$1 AND commitment=$2 ORDER BY mint,token_program").bind(owner).bind(level).fetch_all(&state.pool).await?;
        Ok(GqlJson(Value::Array(rows.into_iter().map(|r|serde_json::json!({"mint":r.get::<String,_>("mint"),"tokenProgram":r.get::<String,_>("token_program"),"amount":r.get::<String,_>("amount"),"frozen":r.get::<String,_>("frozen"),"decimals":r.get::<i16,_>("decimals"),"accountCount":r.get::<i32,_>("account_count"),"slot":r.get::<i64,_>("slot").to_string()})).collect())))
    }
}
