//! HTTP transport and service wiring; query logic is grouped in graphql/.
mod graphql;
use crate::auth;
use async_graphql::Schema;
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
use graphql::{Changes, Mutation, Query};
use sqlx::{postgres::PgListener, PgPool};
use std::{convert::Infallible, time::Duration};
use tokio::sync::broadcast;
#[derive(Clone)]
pub struct ApiState {
    pub pool: PgPool,
    pub revisions: broadcast::Sender<String>,
}
type AppSchema = Schema<Query, Mutation, Changes>;
/// Whether the request came from the app's own origin. Cookie-authenticated
/// mutations require it, so another site cannot act for a signed-in user.
#[derive(Clone, Copy)]
pub struct SameOrigin(pub bool);
#[derive(Clone)]
struct HttpState {
    schema: AppSchema,
    pool: PgPool,
    origin: std::sync::Arc<str>,
}
async fn execute(
    State(state): State<HttpState>,
    headers: HeaderMap,
    Json(request): Json<async_graphql::Request>,
) -> (StatusCode, Json<async_graphql::Response>) {
    let user = match auth::current(&state.pool, &headers).await {
        Ok(user) => user,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(async_graphql::Response::from_errors(vec![
                    async_graphql::ServerError::new("Indexed data service is unavailable", None),
                ])),
            )
        }
    };
    let same_origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        == Some(state.origin.as_ref());
    graphql_response(
        state
            .schema
            .execute(request.data(user).data(SameOrigin(same_origin)))
            .await,
    )
}

fn graphql_response(
    mut response: async_graphql::Response,
) -> (StatusCode, Json<async_graphql::Response>) {
    let mut status = StatusCode::OK;
    for error in &mut response.errors {
        if error
            .source
            .as_ref()
            .is_some_and(|source| source.is::<sqlx::Error>())
        {
            status = StatusCode::SERVICE_UNAVAILABLE;
            error.message = "Indexed data service is unavailable".into();
        }
    }
    (status, Json(response))
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
    let schema = Schema::build(Query::default(), Mutation::default(), Changes)
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
            origin: auth.origin.clone(),
        })
        .merge(auth::router(auth))
        .layer(DefaultBodyLimit::max(32768))
        .layer(axum::middleware::map_response(
            |mut response: axum::response::Response| async move {
                response.headers_mut().insert(
                    axum::http::header::CACHE_CONTROL,
                    axum::http::HeaderValue::from_static("no-store"),
                );
                response
            },
        ))
}

pub fn schema_sdl() -> String {
    Schema::build(Query::default(), Mutation::default(), Changes)
        .finish()
        .sdl()
}

#[cfg(test)]
mod tests;
