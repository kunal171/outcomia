//! HTTP health endpoints used by container orchestrators.

use std::{
    io,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Json, Router};
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
    /// Starts a shared readiness state in the not-ready condition.
    ///
    /// # Inputs
    /// A cloneable PostgreSQL pool; no connection probe occurs during construction.
    ///
    /// # Errors
    /// None; this constructor does not return a Result.
    ///
    /// # Returns
    /// HealthState clones share one readiness bit and the same underlying database pool.
    pub fn new(pool: PgPool) -> Self {
        Self {
            caught_up: Arc::new(AtomicBool::new(false)),
            pool,
        }
    }

    /// Marks the indexer ready only after complete HTTP gap recovery.
    ///
    /// # Inputs
    /// Borrowed HealthState shared by the ingestion task and HTTP server.
    ///
    /// # Errors
    /// None; no database/network request occurs here.
    ///
    /// # Returns
    /// Sets the readiness bit with Release ordering; readiness still requires a successful database
    /// probe.
    pub fn mark_ready(&self) {
        self.caught_up.store(true, Ordering::Release);
    }

    /// Removes readiness while reconnecting or recovering from an error.
    ///
    /// # Inputs
    /// Borrowed shared HealthState.
    ///
    /// # Errors
    /// None; this only stores the readiness bit.
    ///
    /// # Returns
    /// Readiness bit becomes false; liveness and the pool remain intact.
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
///
/// # Inputs
/// No application inputs or dependency checks.
///
/// # Errors
/// No Result error is returned; database/RPC outages are intentionally excluded from liveness.
///
/// # Returns
/// JSON status `alive`; the handler does not claim ingestion is caught up.
async fn liveness() -> Json<HealthResponse> {
    Json(HealthResponse { status: "alive" })
}

/// Readiness requires both completed chain recovery and PostgreSQL access.
///
/// # Inputs
/// Axum State containing the shared readiness bit and PostgreSQL pool.
///
/// # Errors
/// A failed `SELECT 1` is represented by HTTP 503 rather than propagated as a handler error.
///
/// # Returns
/// HTTP 200/ready only when both checks pass, otherwise 503/not_ready; this is not a time-based
/// freshness guarantee.
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
///
/// # Inputs
/// Already bound Tokio TcpListener and shared HealthState.
///
/// # Errors
/// Server/IO failures propagate as io::Error; address-binding failures belong to startup.
///
/// # Returns
/// Completes when serving ends or fails; exposes separate liveness and readiness routes.
pub async fn serve(listener: TcpListener, state: HealthState) -> io::Result<()> {
    let router = Router::new()
        .route("/health/live", get(liveness))
        .route("/health/ready", get(readiness))
        .with_state(state);

    axum::serve(listener, router)
        .await
        .map_err(io::Error::other)
}
