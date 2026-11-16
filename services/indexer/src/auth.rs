//! Wallet ownership creates a user/session; it never credits a financial balance.
use axum::{
    extract::State,
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
use std::{str::FromStr, sync::Arc};

#[derive(Clone)]
pub struct AuthState {
    pub pool: PgPool,
    pub origin: Arc<str>,
    pub domain: Arc<str>,
    pub secure: bool,
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
    })
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
    headers: HeaderMap,
    Json(input): Json<WalletInput>,
) -> Result<Response> {
    check_origin(&state, &headers)?;
    Pubkey::from_str(&input.wallet).map_err(|_| bad())?;
    let nonce = random();
    let mut tx = state.pool.begin().await?;
    // One bounded global issuance gate also serializes per-wallet rate checks.
    sqlx::query("SELECT pg_advisory_xact_lock(718219491)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM login_challenges WHERE expires_at<NOW()")
        .execute(&mut *tx)
        .await?;
    let (global,owned):(i64,i64)=sqlx::query_as("SELECT COUNT(*),COUNT(*) FILTER(WHERE wallet_address=$1) FROM login_challenges WHERE created_at>NOW()-INTERVAL '1 minute'").bind(&input.wallet).fetch_one(&mut *tx).await?;
    if global >= 120 || owned >= 5 {
        return Err(AuthError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many sign-in requests; retry shortly",
        ));
    }
    let (issued,expires):(String,String)=sqlx::query_as("SELECT to_char(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'),to_char((NOW()+INTERVAL '5 minutes') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')").fetch_one(&mut *tx).await?;
    let message=format!("{} wants you to sign in with your Solana account:\n{}\n\nSign in to Outcomia.\n\nURI: {}\nVersion: 1\nChain ID: devnet\nNonce: {}\nIssued At: {}\nExpiration Time: {}",state.domain,input.wallet,state.origin,nonce,issued,expires);
    sqlx::query("INSERT INTO login_challenges(challenge_hash,wallet_address,domain,message,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '5 minutes')")
        .bind(hash(&nonce)).bind(&input.wallet).bind(state.origin.as_ref()).bind(&message).execute(&mut *tx).await?;
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
    let id:String=sqlx::query_scalar("INSERT INTO users(wallet_address) VALUES($1) ON CONFLICT(wallet_address) DO UPDATE SET last_login_at=NOW() RETURNING id::text")
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
    let row=sqlx::query("SELECT u.id::text,u.wallet_address FROM users u JOIN user_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>NOW()")
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
