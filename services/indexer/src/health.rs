//! HTTP health endpoints used by container orchestrators.

use std::{
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Serialize;
use sqlx::PgPool;
use tokio::net::TcpListener;

/// Shared operational state exposed through the readiness endpoint.
#[derive(Clone)]
pub struct HealthState {
    caught_up: Arc<AtomicBool>,
    pool: PgPool,
}

impl HealthState {
    pub fn new(pool: PgPool) -> Self {
        Self {
            caught_up: Arc::new(AtomicBool::new(false)),
            pool,
        }
    }

    /// Marks the indexer ready only after complete HTTP gap recovery.
    pub fn mark_ready(&self) {
        self.caught_up.store(true, Ordering::Release);
    }

    /// Removes readiness while reconnecting or recovering from an error.
    pub fn mark_not_ready(&self) {
        self.caught_up.store(false, Ordering::Release);
    }
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
}

/// Liveness deliberately avoids external dependencies.
///
/// PostgreSQL or Solana failures should make the pod unready, not make
/// Kubernetes continuously restart an otherwise healthy process.
async fn liveness() -> Json<HealthResponse> {
    Json(HealthResponse { status: "alive" })
}

/// Readiness requires both completed chain recovery and PostgreSQL access.
async fn readiness(State(state): State<HealthState>) -> impl IntoResponse {
    let database_reachable = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();

    let caught_up = state.caught_up.load(Ordering::Acquire);
    let ready = caught_up && database_reachable;

    let status_code = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    let response = HealthResponse {
        status: if ready { "ready" } else { "not_ready" },
    };

    (status_code, Json(response))
}

/// Runs the internal health server on an already-bound listener.
///
/// Binding happens in `main` so an invalid address or occupied port stops
/// startup instead of silently leaving the process without health endpoints.
pub async fn serve(listener: TcpListener, state: HealthState) -> io::Result<()> {
    let router = Router::new()
        .route("/health/live", get(liveness))
        .route("/health/ready", get(readiness))
        .with_state(state);

    axum::serve(listener, router)
        .await
        .map_err(io::Error::other)
}