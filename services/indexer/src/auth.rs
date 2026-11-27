//! Wallet ownership creates a user/session; it never credits a financial balance.
use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;
use sqlx::{PgPool, Row};
use std::{
    net::{IpAddr, SocketAddr},
    str::FromStr,
    sync::Arc,
};

#[derive(Clone)]
pub struct AuthState {
    pub pool: PgPool,
    pub origin: Arc<str>,
    pub domain: Arc<str>,
    pub secure: bool,
    /// Secret the app proxy sends with the browser's IP; see `client_key`.
    pub proxy_secret: Option<Arc<str>>,
    /// Canton sign-in and linking; off when not configured.
    pub canton: Option<crate::canton_auth::CantonAuth>,
}
#[derive(Debug)]
pub struct AuthError(pub StatusCode, pub &'static str);
impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx::Error> for AuthError {
    fn from(_: sqlx::Error) -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "Authentication storage unavailable",
        )
    }
}
pub(crate) type Result<T> = std::result::Result<T, AuthError>;
pub(crate) const SESSION: &str = "outcomia_session";
/// Challenges any one client may request per minute.
const CHALLENGES_PER_CLIENT: i64 = 10;
/// Challenges for one wallet address per minute.
const CHALLENGES_PER_WALLET: i64 = 5;
/// Safety ceiling across all clients per minute; not the primary control.
const CHALLENGES_GLOBAL: i64 = 600;
/// Headers set by the app's server-side proxy, never trusted without the secret.
pub(crate) const CLIENT_IP_HEADER: &str = "x-outcomia-client-ip";
pub(crate) const PROXY_TOKEN_HEADER: &str = "x-outcomia-proxy-token";
pub(crate) const CHALLENGE: &str = "outcomia_challenge";
fn bad() -> AuthError {
    AuthError(
        StatusCode::UNAUTHORIZED,
        "Invalid or expired wallet sign-in",
    )
}
pub(crate) fn random() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    bs58::encode(bytes).into_string()
}
pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub(crate) fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|s| s.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_owned())
}
pub(crate) fn set_cookie(name: &str, value: &str, seconds: u32, secure: bool) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={seconds}{}",
        if secure { "; Secure" } else { "" }
    ))
    .expect("generated cookie")
}
pub(crate) fn check_origin(state: &AuthState, headers: &HeaderMap) -> Result<()> {
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) != Some(state.origin.as_ref()) {
        return Err(AuthError(StatusCode::FORBIDDEN, "Sign-in origin mismatch"));
    }
    Ok(())
}
pub fn state(pool: PgPool, origin: &str) -> std::result::Result<AuthState, String> {
    let uri = axum::http::Uri::from_str(origin).map_err(|_| "Invalid APP_ORIGIN")?;
    let domain = uri
        .authority()
        .ok_or("APP_ORIGIN needs an authority")?
        .as_str();
    let secure = uri.scheme_str() == Some("https");
    let local = matches!(uri.host(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (!secure && !(uri.scheme_str() == Some("http") && local))
        || uri.path() != "/"
        || uri.query().is_some()
        || origin.ends_with('/')
        || domain.contains('@')
    {
        return Err("APP_ORIGIN must be an HTTPS origin (HTTP is allowed only on loopback), without a trailing slash".into());
    }
    Ok(AuthState {
        pool,
        origin: origin.into(),
        domain: domain.into(),
        secure,
        proxy_secret: None,
        canton: None,
    })
}
impl AuthState {
    /// Inputs: optional proxy secret. Errors: a secret shorter than 32 bytes.
    /// Returns: state that trusts forwarded client IPs only with that secret.
    pub fn with_proxy_secret(
        mut self,
        secret: Option<String>,
    ) -> std::result::Result<Self, String> {
        if let Some(secret) = secret {
            if secret.len() < 32 {
                return Err("INDEXER_PROXY_SECRET must be at least 32 characters".into());
            }
            self.proxy_secret = Some(secret.into());
        }
        Ok(self)
    }
}
/// Compares secrets without stopping at the first differing byte.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0_u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
/// Rate-limit identity for one sign-in request, stored only as a digest.
///
/// The app's server-side proxy forwards the browser's IP with a shared secret;
/// that IP is trusted only when the secret matches, because the API port is
/// public and any caller could otherwise forge the header. Without it, the TCP
/// peer address is used (behind a load balancer that is the balancer itself,
/// so direct callers share one bucket).
pub(crate) fn client_key(
    state: &AuthState,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> String {
    let forwarded = state.proxy_secret.as_deref().and_then(|secret| {
        let token = headers.get(PROXY_TOKEN_HEADER)?.to_str().ok()?;
        if !constant_time_eq(token.as_bytes(), secret.as_bytes()) {
            return None;
        }
        headers
            .get(CLIENT_IP_HEADER)?
            .to_str()
            .ok()?
            .trim()
            .parse::<IpAddr>()
            .ok()
    });
    match (forwarded, peer) {
        (Some(ip), _) => hash(&format!("client:{ip}")),
        (None, Some(addr)) => hash(&format!("peer:{}", addr.ip())),
        (None, None) => hash("unknown"),
    }
}
#[derive(Deserialize)]
struct WalletInput {
    wallet: String,
}
#[derive(Deserialize)]
struct VerifyInput {
    wallet: String,
    nonce: String,
    signature: String,
}
#[derive(Serialize)]
struct ChallengeResponse {
    nonce: String,
    message: String,
}
/// The signed-in user: a Solana wallet, Canton parties, or both.
#[derive(Clone, Debug, Serialize)]
pub struct User {
    pub id: String,
    /// Solana wallet; `None` for a Canton-only user.
    pub wallet: Option<String>,
    /// Canton parties proven on the ledger, oldest first.
    pub parties: Vec<String>,
}
async fn challenge(
    State(state): State<AuthState>,
    peer: Option<axum::Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(input): Json<WalletInput>,
) -> Result<Response> {
    check_origin(&state, &headers)?;
    Pubkey::from_str(&input.wallet).map_err(|_| bad())?;
    let client = client_key(
        &state,
        &headers,
        peer.map(|axum::Extension(ConnectInfo(a))| a),
    );
    let nonce = random();
    let mut tx = state.pool.begin().await?;
    // One bounded global issuance gate also serializes per-wallet rate checks.
    sqlx::query("SELECT pg_advisory_xact_lock(718219491)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM login_challenges WHERE expires_at<NOW()")
        .execute(&mut *tx)
        .await?;
    let (global,owned,from_client):(i64,i64,i64)=sqlx::query_as("SELECT COUNT(*),COUNT(*) FILTER(WHERE wallet_address=$1),COUNT(*) FILTER(WHERE client_hash=$2) FROM login_challenges WHERE created_at>NOW()-INTERVAL '1 minute'").bind(&input.wallet).bind(&client).fetch_one(&mut *tx).await?;
    if from_client >= CHALLENGES_PER_CLIENT
        || owned >= CHALLENGES_PER_WALLET
        || global >= CHALLENGES_GLOBAL
    {
        return Err(AuthError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many sign-in requests; retry shortly",
        ));
    }
    let (issued,expires):(String,String)=sqlx::query_as("SELECT to_char(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),to_char((NOW()+INTERVAL '5 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')").fetch_one(&mut *tx).await?;
    let message=format!("{} wants you to sign in with your Solana account:\n{}\n\nSign in to Outcomia.\n\nURI: {}\nVersion: 1\nChain ID: devnet\nNonce: {}\nIssued At: {}\nExpiration Time: {}",state.domain,input.wallet,state.origin,nonce,issued,expires);
    sqlx::query("INSERT INTO login_challenges(challenge_hash,wallet_address,domain,message,expires_at,client_hash) VALUES($1,$2,$3,$4,NOW()+INTERVAL '5 minutes',$5)")
        .bind(hash(&nonce)).bind(&input.wallet).bind(state.origin.as_ref()).bind(&message).bind(&client).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut response = Json(ChallengeResponse {
        nonce: nonce.clone(),
        message,
    })
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        set_cookie(CHALLENGE, &nonce, 300, state.secure),
    );
    Ok(response)
}
pub fn verify_signature(wallet: &str, message: &str, signature: &str) -> Result<()> {
    let key = Pubkey::from_str(wallet).map_err(|_| bad())?;
    let key = VerifyingKey::from_bytes(&key.to_bytes()).map_err(|_| bad())?;
    let bytes = STANDARD.decode(signature).map_err(|_| bad())?;
    let signature = Signature::from_slice(&bytes).map_err(|_| bad())?;
    key.verify_strict(message.as_bytes(), &signature)
        .map_err(|_| bad())
}
/// Checks the browser-bound challenge and the wallet's signature over it, and
/// consumes the challenge. Errors: any mismatch, expiry or replay.
async fn consume_solana_challenge(
    state: &AuthState,
    headers: &HeaderMap,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    input: &VerifyInput,
) -> Result<()> {
    if input.nonce.len() > 64
        || input.signature.len() > 128
        || cookie(headers, CHALLENGE).as_deref() != Some(input.nonce.as_str())
    {
        return Err(bad());
    }
    let row=sqlx::query("SELECT message FROM login_challenges WHERE challenge_hash=$1 AND wallet_address=$2 AND domain=$3 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE")
        .bind(hash(&input.nonce)).bind(&input.wallet).bind(state.origin.as_ref()).fetch_optional(&mut **tx).await?.ok_or_else(bad)?;
    verify_signature(
        &input.wallet,
        &row.get::<String, _>("message"),
        &input.signature,
    )?;
    sqlx::query("UPDATE login_challenges SET consumed_at=NOW() WHERE challenge_hash=$1")
        .bind(hash(&input.nonce))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Starts a 7-day session for `user_id`, rotating the browser's previous one.
/// Returns: the session token for the cookie; only its digest is stored.
pub(crate) async fn start_session(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    headers: &HeaderMap,
    user_id: &str,
    challenge_hash: &str,
) -> Result<String> {
    if let Some(old) = cookie(headers, SESSION) {
        sqlx::query("DELETE FROM user_sessions WHERE token_hash=$1")
            .bind(hash(&old))
            .execute(&mut **tx)
            .await?;
    }
    sqlx::query("DELETE FROM user_sessions WHERE expires_at<NOW()")
        .execute(&mut **tx)
        .await?;
    let token = random();
    sqlx::query("INSERT INTO user_sessions(token_hash,user_id,expires_at,challenge_hash) VALUES($1,$2::uuid,NOW()+INTERVAL '7 days',$3)").bind(hash(&token)).bind(user_id).bind(challenge_hash).execute(&mut **tx).await?;
    Ok(token)
}

/// The user's JSON with the new session cookie set and the challenge cleared.
pub(crate) fn session_response(state: &AuthState, user: User, token: &str) -> Response {
    let mut response = Json(user).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(SESSION, token, 604800, state.secure),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(CHALLENGE, "", 0, state.secure),
    );
    response
}

/// Loads a user with its linked Canton parties.
pub(crate) async fn load_user(executor: impl sqlx::PgExecutor<'_>, user_id: &str) -> Result<User> {
    let (wallet, parties): (Option<String>, Vec<String>) = sqlx::query_as(
        "SELECT u.wallet_address,
                ARRAY(SELECT a.party FROM canton_accounts a WHERE a.user_id=u.id ORDER BY a.linked_at,a.party)
           FROM users u WHERE u.id=$1::uuid",
    )
    .bind(user_id)
    .fetch_one(executor)
    .await?;
    Ok(User {
        id: user_id.to_owned(),
        wallet,
        parties,
    })
}

async fn verify(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<VerifyInput>,
) -> Result<Response> {
    check_origin(&state, &headers)?;
    let mut tx = state.pool.begin().await?;
    consume_solana_challenge(&state, &headers, &mut tx, &input).await?;
    let id:String=sqlx::query_scalar("INSERT INTO users(wallet_address,last_login_at,verified_at) VALUES($1,NOW(),NOW()) ON CONFLICT(wallet_address) DO UPDATE SET last_login_at=NOW(),verified_at=COALESCE(users.verified_at,NOW()) RETURNING id::text")
        .bind(&input.wallet).fetch_one(&mut *tx).await?;
    let token = start_session(&mut tx, &headers, &id, &hash(&input.nonce)).await?;
    sqlx::query("INSERT INTO tracked_wallets(owner) VALUES($1) ON CONFLICT(owner) DO UPDATE SET requested_at=NOW()").bind(&input.wallet).execute(&mut *tx).await?;
    let user = load_user(&mut *tx, &id).await?;
    tx.commit().await?;
    Ok(session_response(&state, user, &token))
}

/// A Canton-only user adds a Solana wallet, proven by the same signed
/// challenge as sign-in. If the wallet already has its own user, the Canton
/// user is merged into it (refused when both have profiles) and this browser's
/// session moves with it.
async fn link_solana(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<VerifyInput>,
) -> Result<Response> {
    check_origin(&state, &headers)?;
    let user = current(&state.pool, &headers)
        .await?
        .ok_or_else(signed_out)?;
    if user.wallet.is_some() {
        return Err(AuthError(
            StatusCode::CONFLICT,
            "This profile already has a Solana wallet",
        ));
    }
    let mut tx = state.pool.begin().await?;
    consume_solana_challenge(&state, &headers, &mut tx, &input).await?;
    let existing: Option<String> =
        sqlx::query_scalar("SELECT id::text FROM users WHERE wallet_address=$1 FOR UPDATE")
            .bind(&input.wallet)
            .fetch_optional(&mut *tx)
            .await?;
    let owner = match existing {
        None => {
            sqlx::query("UPDATE users SET wallet_address=$2,verified_at=COALESCE(verified_at,NOW()) WHERE id=$1::uuid")
                .bind(&user.id).bind(&input.wallet).execute(&mut *tx).await?;
            sqlx::query("UPDATE profiles SET wallet=$2,updated_at=NOW() WHERE user_id=$1::uuid")
                .bind(&user.id)
                .bind(&input.wallet)
                .execute(&mut *tx)
                .await?;
            user.id.clone()
        }
        Some(into) => {
            let token = cookie(&headers, SESSION).unwrap_or_default();
            merge_canton_user(&mut tx, &user.id, &into, Some(&token)).await?;
            into
        }
    };
    sqlx::query("INSERT INTO tracked_wallets(owner) VALUES($1) ON CONFLICT(owner) DO UPDATE SET requested_at=NOW()").bind(&input.wallet).execute(&mut *tx).await?;
    let linked = load_user(&mut *tx, &owner).await?;
    tx.commit().await?;
    let mut response = Json(linked).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(CHALLENGE, "", 0, state.secure),
    );
    Ok(response)
}

/// Moves a Canton-only user's parties and profile into `into`, then deletes
/// it. `keep_session` (a token) moves that one session too; other sessions of
/// the merged user end. Errors: both users have profiles, or `from` has a
/// Solana wallet (two wallets are never combined).
pub(crate) async fn merge_canton_user(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    from: &str,
    into: &str,
    keep_session: Option<&str>,
) -> Result<()> {
    let (wallet, profiles): (Option<String>, i64) = sqlx::query_as(
        "SELECT (SELECT wallet_address FROM users WHERE id=$1::uuid),
                (SELECT COUNT(*) FROM profiles WHERE user_id IN ($1::uuid,$2::uuid))",
    )
    .bind(from)
    .bind(into)
    .fetch_one(&mut **tx)
    .await?;
    if wallet.is_some() {
        return Err(AuthError(
            StatusCode::CONFLICT,
            "That account belongs to another profile",
        ));
    }
    if profiles > 1 {
        return Err(AuthError(
            StatusCode::CONFLICT,
            "Both accounts already have profiles; delete one before linking",
        ));
    }
    let parties: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM canton_accounts WHERE user_id IN ($1::uuid,$2::uuid)",
    )
    .bind(from)
    .bind(into)
    .fetch_one(&mut **tx)
    .await?;
    if parties > crate::canton_auth::MAX_PARTIES {
        return Err(AuthError(
            StatusCode::CONFLICT,
            "A profile can link at most 5 Canton parties",
        ));
    }
    sqlx::query("UPDATE canton_accounts SET user_id=$2::uuid WHERE user_id=$1::uuid")
        .bind(from)
        .bind(into)
        .execute(&mut **tx)
        .await?;
    sqlx::query("UPDATE profiles SET user_id=$2::uuid,wallet=(SELECT wallet_address FROM users WHERE id=$2::uuid),updated_at=NOW() WHERE user_id=$1::uuid")
        .bind(from).bind(into).execute(&mut **tx).await?;
    if let Some(token) = keep_session {
        sqlx::query(
            "UPDATE user_sessions SET user_id=$2::uuid WHERE user_id=$1::uuid AND token_hash=$3",
        )
        .bind(from)
        .bind(into)
        .bind(hash(token))
        .execute(&mut **tx)
        .await?;
    }
    sqlx::query("DELETE FROM users WHERE id=$1::uuid")
        .bind(from)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(crate) fn signed_out() -> AuthError {
    AuthError(StatusCode::UNAUTHORIZED, "Sign in first")
}

pub async fn current(pool: &PgPool, headers: &HeaderMap) -> Result<Option<User>> {
    let Some(token) = cookie(headers, SESSION) else {
        return Ok(None);
    };
    if token.len() > 64 {
        return Ok(None);
    }
    let id: Option<String> = sqlx::query_scalar("SELECT u.id::text FROM users u JOIN user_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.verified_at IS NOT NULL")
        .bind(hash(&token)).fetch_optional(pool).await?;
    let Some(id) = id else {
        return Ok(None);
    };
    let user = load_user(pool, &id).await?;
    if let Some(wallet) = &user.wallet {
        sqlx::query("UPDATE tracked_wallets SET requested_at=NOW() WHERE owner=$1 AND requested_at<NOW()-INTERVAL '1 minute'").bind(wallet).execute(pool).await?;
    }
    Ok(Some(user))
}
async fn me(State(state): State<AuthState>, headers: HeaderMap) -> Result<Json<Option<User>>> {
    Ok(Json(current(&state.pool, &headers).await?))
}

async fn logout(State(state): State<AuthState>, headers: HeaderMap) -> Result<Response> {
    check_origin(&state, &headers)?;
    if let Some(nonce) = cookie(&headers, CHALLENGE) {
        let mut tx = state.pool.begin().await?;
        sqlx::query("UPDATE login_challenges SET consumed_at=NOW() WHERE challenge_hash=$1")
            .bind(hash(&nonce))
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM user_sessions WHERE challenge_hash=$1")
            .bind(hash(&nonce))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    if let Some(token) = cookie(&headers, SESSION) {
        sqlx::query("DELETE FROM user_sessions WHERE token_hash=$1")
            .bind(hash(&token))
            .execute(&state.pool)
            .await?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .append(header::SET_COOKIE, set_cookie(SESSION, "", 0, state.secure));
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(CHALLENGE, "", 0, state.secure),
    );
    Ok(response)
}
pub fn router(state: AuthState) -> Router {
    Router::new()
        .route("/auth/challenge", post(challenge))
        .route("/auth/verify", post(verify))
        .route("/auth/solana/link", post(link_solana))
        .merge(crate::canton_auth::routes())
        .route("/auth/me", get(me))
        .route("/auth/logout", post(logout))
        .with_state(state)
}
#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    const SECRET: &str = "0123456789abcdef0123456789abcdef";
    fn proxied(ip: &str, token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CLIENT_IP_HEADER, HeaderValue::from_str(ip).unwrap());
        headers.insert(PROXY_TOKEN_HEADER, HeaderValue::from_str(token).unwrap());
        headers
    }
    async fn lazy_state(secret: Option<&str>) -> AuthState {
        let pool = PgPool::connect_lazy("postgres://unused/unused").unwrap();
        state(pool, "http://localhost:3000")
            .unwrap()
            .with_proxy_secret(secret.map(str::to_owned))
            .unwrap()
    }
    #[tokio::test]
    async fn forwarded_client_ip_is_trusted_only_with_the_proxy_secret() {
        let peer: SocketAddr = "10.0.0.9:443".parse().unwrap();
        let state = lazy_state(Some(SECRET)).await;
        let a = client_key(&state, &proxied("203.0.113.7", SECRET), Some(peer));
        let b = client_key(&state, &proxied("203.0.113.8", SECRET), Some(peer));
        assert_ne!(
            a, b,
            "distinct browsers behind the proxy get distinct buckets"
        );
        assert_eq!(a, hash("client:203.0.113.7"));
        // A forged or missing token falls back to the TCP peer.
        let forged = client_key(&state, &proxied("203.0.113.7", "wrong-secret"), Some(peer));
        assert_eq!(forged, hash("peer:10.0.0.9"));
        assert_eq!(client_key(&state, &HeaderMap::new(), Some(peer)), forged);
        // An unparsable forwarded IP is never used.
        assert_eq!(
            client_key(&state, &proxied("not-an-ip", SECRET), Some(peer)),
            forged
        );
        // Without a configured secret, forwarded headers are ignored entirely.
        let open = lazy_state(None).await;
        assert_eq!(
            client_key(&open, &proxied("203.0.113.7", SECRET), Some(peer)),
            forged
        );
        assert_eq!(client_key(&open, &HeaderMap::new(), None), hash("unknown"));
    }
    #[tokio::test]
    async fn proxy_secret_must_be_long_and_compares_exactly() {
        let pool = PgPool::connect_lazy("postgres://unused/unused").unwrap();
        let base = state(pool, "http://localhost:3000").unwrap();
        assert!(base
            .clone()
            .with_proxy_secret(Some("short".into()))
            .is_err());
        assert!(base.with_proxy_secret(Some(SECRET.into())).is_ok());
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn one_client_cycling_wallets_cannot_block_other_clients(pool: PgPool) {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let app = router(
            state(pool, "http://localhost:3000")
                .unwrap()
                .with_proxy_secret(Some(SECRET.into()))
                .unwrap(),
        );
        let ask = |ip: &str, seed: u8| {
            let wallet = bs58::encode(
                SigningKey::from_bytes(&[seed; 32])
                    .verifying_key()
                    .to_bytes(),
            )
            .into_string();
            Request::builder()
                .uri("/auth/challenge")
                .method("POST")
                .header("content-type", "application/json")
                .header("origin", "http://localhost:3000")
                .header(CLIENT_IP_HEADER, ip)
                .header(PROXY_TOKEN_HEADER, SECRET)
                .body(Body::from(serde_json::json!({"wallet":wallet}).to_string()))
                .unwrap()
        };
        // The attacker rotates a fresh wallet on every request.
        for seed in 1..=CHALLENGES_PER_CLIENT as u8 {
            let response = app
                .clone()
                .oneshot(ask("198.51.100.1", seed))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        let blocked = app.clone().oneshot(ask("198.51.100.1", 99)).await.unwrap();
        assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);
        // Another browser is unaffected.
        let other = app.clone().oneshot(ask("198.51.100.2", 100)).await.unwrap();
        assert_eq!(other.status(), StatusCode::OK);
    }
    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn challenge_replay_origin_and_session_rotation(pool: PgPool) {
        use axum::{
            body::{to_bytes, Body},
            http::Request,
        };
        use tower::ServiceExt;
        let state = state(pool.clone(), "http://localhost:3000").unwrap();
        let app = router(state);
        let key = SigningKey::from_bytes(&[8; 32]);
        let wallet = bs58::encode(key.verifying_key().to_bytes()).into_string();
        // A deposit-discovered profile is upgraded, preserving its original ID.
        let discovered_id: String = sqlx::query_scalar("INSERT INTO users(wallet_address,registration_source,first_observed_slot) VALUES($1,'chain',50) RETURNING id::text")
            .bind(&wallet).fetch_one(&pool).await.unwrap();
        let request = |path: &str, body: serde_json::Value, cookie: &str, origin: &str| {
            Request::builder()
                .uri(path)
                .method("POST")
                .header("content-type", "application/json")
                .header("origin", origin)
                .header("cookie", cookie)
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let wrong = app
            .clone()
            .oneshot(request(
                "/auth/challenge",
                serde_json::json!({"wallet":wallet}),
                "",
                "http://other.example",
            ))
            .await
            .unwrap();
        assert_eq!(wrong.status(), StatusCode::FORBIDDEN);
        let response = app
            .clone()
            .oneshot(request(
                "/auth/challenge",
                serde_json::json!({"wallet":wallet}),
                "",
                "http://localhost:3000",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let binding = response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let doc: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
        let payload = serde_json::json!({"wallet":wallet,"nonce":doc["nonce"],"signature":STANDARD.encode(key.sign(doc["message"].as_str().unwrap().as_bytes()).to_bytes())});
        let missing_cookie = app
            .clone()
            .oneshot(request(
                "/auth/verify",
                payload.clone(),
                "",
                "http://localhost:3000",
            ))
            .await
            .unwrap();
        assert_eq!(missing_cookie.status(), StatusCode::UNAUTHORIZED);
        let response = app
            .clone()
            .oneshot(request(
                "/auth/verify",
                payload.clone(),
                &binding,
                "http://localhost:3000",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let session = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|h| h.to_str().unwrap())
            .find(|h| h.starts_with("outcomia_session="))
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let replay = app
            .clone()
            .oneshot(request(
                "/auth/verify",
                payload,
                &binding,
                "http://localhost:3000",
            ))
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(&session).unwrap());
        assert_eq!(
            current(&pool, &headers).await.unwrap().unwrap().wallet,
            Some(wallet.clone())
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        let profile = sqlx::query("SELECT id::text,verified_at IS NOT NULL AS verified,last_login_at IS NOT NULL AS signed_in FROM users WHERE wallet_address=$1")
            .bind(&wallet).fetch_one(&pool).await.unwrap();
        assert_eq!(profile.get::<String, _>("id"), discovered_id);
        assert!(profile.get::<bool, _>("verified"));
        assert!(profile.get::<bool, _>("signed_in"));
        let logout = app
            .oneshot(request(
                "/auth/logout",
                serde_json::json!({}),
                &binding,
                "http://localhost:3000",
            ))
            .await
            .unwrap();
        assert_eq!(logout.status(), StatusCode::NO_CONTENT);
        assert!(current(&pool, &headers).await.unwrap().is_none());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM wallet_assets")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }

    #[test]
    fn signature_binds_exact_message_and_wallet() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let wallet = bs58::encode(key.verifying_key().to_bytes()).into_string();
        let signature = STANDARD.encode(key.sign(b"domain-bound nonce").to_bytes());
        assert!(verify_signature(&wallet, "domain-bound nonce", &signature).is_ok());
        assert!(verify_signature(&wallet, "another nonce", &signature).is_err());
        assert!(verify_signature(
            &bs58::encode([0; 32]).into_string(),
            "domain-bound nonce",
            &signature
        )
        .is_err());
        assert!(verify_signature(&wallet, "domain-bound nonce", "bad").is_err());
    }
}
