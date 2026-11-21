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
type Result<T> = std::result::Result<T, AuthError>;
const SESSION: &str = "outcomia_session";
/// Challenges any one client may request per minute.
const CHALLENGES_PER_CLIENT: i64 = 10;
/// Challenges for one wallet address per minute.
const CHALLENGES_PER_WALLET: i64 = 5;
/// Safety ceiling across all clients per minute; not the primary control.
const CHALLENGES_GLOBAL: i64 = 600;
/// Headers set by the app's server-side proxy, never trusted without the secret.
const CLIENT_IP_HEADER: &str = "x-outcomia-client-ip";
const PROXY_TOKEN_HEADER: &str = "x-outcomia-proxy-token";
const CHALLENGE: &str = "outcomia_challenge";
fn bad() -> AuthError {
    AuthError(
        StatusCode::UNAUTHORIZED,
        "Invalid or expired wallet sign-in",
    )
}
fn random() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    bs58::encode(bytes).into_string()
}
pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|s| s.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_owned())
}
fn set_cookie(name: &str, value: &str, seconds: u32, secure: bool) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={seconds}{}",
        if secure { "; Secure" } else { "" }
    ))
    .expect("generated cookie")
}
fn check_origin(state: &AuthState, headers: &HeaderMap) -> Result<()> {
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
fn client_key(state: &AuthState, headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
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
#[derive(Clone, Serialize)]
pub struct User {
    pub id: String,
    pub wallet: String,
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
async fn verify(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<VerifyInput>,
) -> Result<Response> {
    check_origin(&state, &headers)?;
    if input.nonce.len() > 64
        || input.signature.len() > 128
        || cookie(&headers, CHALLENGE).as_deref() != Some(input.nonce.as_str())
    {
        return Err(bad());
    }
    let mut tx = state.pool.begin().await?;
    let row=sqlx::query("SELECT message FROM login_challenges WHERE challenge_hash=$1 AND wallet_address=$2 AND domain=$3 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE")
        .bind(hash(&input.nonce)).bind(&input.wallet).bind(state.origin.as_ref()).fetch_optional(&mut *tx).await?.ok_or_else(bad)?;
    verify_signature(
        &input.wallet,
        &row.get::<String, _>("message"),
        &input.signature,
    )?;
    sqlx::query("UPDATE login_challenges SET consumed_at=NOW() WHERE challenge_hash=$1")
        .bind(hash(&input.nonce))
        .execute(&mut *tx)
        .await?;
    let id:String=sqlx::query_scalar("INSERT INTO users(wallet_address,last_login_at,verified_at) VALUES($1,NOW(),NOW()) ON CONFLICT(wallet_address) DO UPDATE SET last_login_at=NOW(),verified_at=COALESCE(users.verified_at,NOW()) RETURNING id::text")
        .bind(&input.wallet).fetch_one(&mut *tx).await?;
    // Rotate the browser's previous credential; store only the new token digest.
    if let Some(old) = cookie(&headers, SESSION) {
        sqlx::query("DELETE FROM user_sessions WHERE token_hash=$1")
            .bind(hash(&old))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM user_sessions WHERE expires_at<NOW()")
        .execute(&mut *tx)
        .await?;
    let token = random();
    sqlx::query("INSERT INTO user_sessions(token_hash,user_id,expires_at,challenge_hash) VALUES($1,$2::uuid,NOW()+INTERVAL '7 days',$3)").bind(hash(&token)).bind(&id).bind(hash(&input.nonce)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO tracked_wallets(owner) VALUES($1) ON CONFLICT(owner) DO UPDATE SET requested_at=NOW()").bind(&input.wallet).execute(&mut *tx).await?;
    tx.commit().await?;
    let mut response = Json(User {
        id,
        wallet: input.wallet,
    })
    .into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(SESSION, &token, 604800, state.secure),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie(CHALLENGE, "", 0, state.secure),
    );
    Ok(response)
}
pub async fn current(pool: &PgPool, headers: &HeaderMap) -> Result<Option<User>> {
    let Some(token) = cookie(headers, SESSION) else {
        return Ok(None);
    };
    if token.len() > 64 {
        return Ok(None);
    }
    let row=sqlx::query("SELECT u.id::text,u.wallet_address FROM users u JOIN user_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.verified_at IS NOT NULL")
        .bind(hash(&token)).fetch_optional(pool).await?;
    let user = row.map(|r| User {
        id: r.get("id"),
        wallet: r.get("wallet_address"),
    });
    if let Some(user) = &user {
        sqlx::query("UPDATE tracked_wallets SET requested_at=NOW() WHERE owner=$1 AND requested_at<NOW()-INTERVAL '1 minute'").bind(&user.wallet).execute(pool).await?;
    }
    Ok(user)
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
        .route("/auth/me", get(me))
        .route("/auth/logout", post(logout))
        .with_state(state)
}
#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
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
            wallet
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
