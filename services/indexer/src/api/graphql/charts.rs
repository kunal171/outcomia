use crate::api::ApiState;
use crate::charts;
use async_graphql::{Context, Object};

#[derive(Default)]
pub struct ChartsQuery;
#[Object]
impl ChartsQuery {
    // Keep chart dimensions explicit in the GraphQL schema.
    #[allow(clippy::too_many_arguments)]
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
