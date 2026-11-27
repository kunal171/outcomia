//! Canton sign-in and linking. The party proves itself with a `ProfileClaim`
//! contract that carries a one-time nonce from here; the claim is read from
//! the ledger as the operator, never trusted from the browser.
use crate::auth::{
    self, check_origin, client_key, cookie, hash, load_user, set_cookie, signed_out, AuthError,
    AuthState, Result, CHALLENGE,
};
use crate::canton::{valid_contract_id, valid_party, CantonConfig, ClaimPurpose, ClaimSource};
use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};

/// Canton parties one profile may link.
pub const MAX_PARTIES: i64 = 5;
const PER_CLIENT: i64 = 10;
const PER_PARTY: i64 = 5;
const GLOBAL: i64 = 600;
/// Claim nonces stay valid this long, enough for a wallet approval.
const CHALLENGE_SECONDS: u32 = 600;

#[derive(Clone)]
pub struct CantonAuth {
    pub config: CantonConfig,
    pub claims: Arc<dyn ClaimSource>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Purpose {
    SignIn,
    Link,
}
impl Purpose {
    fn db(self) -> &'static str {
        match self {
            Self::SignIn => "signIn",
            Self::Link => "link",
        }
    }
}

#[derive(Deserialize)]
struct ChallengeInput {
    party: String,
    purpose: Purpose,
}

/// What the wallet needs to create the claim.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeResponse {
    nonce: String,
    operator: String,
    template_id: String,
    network: String,
    /// `ClaimSignIn` or `ClaimLink`, as the template's constructor.
    purpose: &'static str,
    solana_wallet: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyInput {
    party: String,
    nonce: String,
    contract_id: String,
}

#[derive(Deserialize)]
struct UnlinkInput {
    party: String,
}

fn invalid() -> AuthError {
    AuthError(
        StatusCode::UNAUTHORIZED,
        "Invalid or expired Canton sign-in",
    )
}
fn canton(state: &AuthState) -> Result<&CantonAuth> {
    state.canton.as_ref().ok_or(AuthError(
        StatusCode::NOT_FOUND,
        "Canton sign-in is not configured",
    ))
}
fn nonce() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn challenge(
    State(state): State<AuthState>,
    peer: Option<axum::Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    Json(input): Json<ChallengeInput>,
) -> Result<Response> {
    check_origin(&state, &headers)?;
    let canton = canton(&state)?;
    if !valid_party(&input.party) || input.party == canton.config.operator {
        return Err(AuthError(
            StatusCode::BAD_REQUEST,
            "Enter a valid Canton party",
        ));
    }
    // A link joins the party to the signed-in user, named in the claim by its
    // Solana wallet, so the ledger record says which profile it is for.
    let (user_id, wallet) = match input.purpose {
        Purpose::SignIn => (None, None),
        Purpose::Link => {
            let user = auth::current(&state.pool, &headers)
                .await?
                .ok_or_else(signed_out)?;
            let Some(wallet) = user.wallet else {
                return Err(AuthError(
                    StatusCode::CONFLICT,
                    "Link a Solana wallet first, or sign in with this party instead",
                ));
            };
            (Some(user.id), Some(wallet))
        }
    };
    let client = client_key(
        &state,
        &headers,
        peer.map(|axum::Extension(ConnectInfo(a))| a),
    );
    let nonce = nonce();
    let mut tx = state.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(718219492)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM canton_challenges WHERE expires_at<NOW()")
        .execute(&mut *tx)
        .await?;
    let (global, party, from_client): (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*),COUNT(*) FILTER(WHERE party=$1),COUNT(*) FILTER(WHERE client_hash=$2)
           FROM canton_challenges WHERE created_at>NOW()-INTERVAL '1 minute'",
    )
    .bind(&input.party)
    .bind(&client)
    .fetch_one(&mut *tx)
    .await?;
    if from_client >= PER_CLIENT || party >= PER_PARTY || global >= GLOBAL {
        return Err(AuthError(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many sign-in requests; retry shortly",
        ));
    }
    sqlx::query(
        "INSERT INTO canton_challenges(challenge_hash,network,party,purpose,user_id,solana_wallet,client_hash,expires_at)
         VALUES($1,$2,$3,$4,$5::uuid,$6,$7,NOW()+make_interval(secs => $8))",
    )
    .bind(hash(&nonce))
    .bind(&canton.config.network)
    .bind(&input.party)
    .bind(input.purpose.db())
    .bind(&user_id)
    .bind(&wallet)
    .bind(&client)
    .bind(f64::from(CHALLENGE_SECONDS))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut response = Json(ChallengeResponse {
        nonce: nonce.clone(),
        operator: canton.config.operator.clone(),
        template_id: canton.config.template_id(),
        network: canton.config.network.clone(),
        purpose: match input.purpose {
            Purpose::SignIn => "ClaimSignIn",
            Purpose::Link => "ClaimLink",
        },
        solana_wallet: wallet,
    })
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        set_cookie(CHALLENGE, &nonce, CHALLENGE_SECONDS, state.secure),
    );
    Ok(response)
}

macro_rules! pending_sql {
    () => {
        "SELECT purpose,user_id::text AS user_id,solana_wallet FROM canton_challenges
         WHERE challenge_hash=$1 AND network=$2 AND party=$3 AND consumed_at IS NULL AND expires_at>NOW()"
    };
}
const PENDING: &str = pending_sql!();

struct Pending {
    purpose: String,
    user_id: Option<String>,
    solana_wallet: Option<String>,
}

async fn verify(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<VerifyInput>,
) -> Result<Response> {
    check_origin(&state, &headers)?;
    let canton = canton(&state)?;
    if input.nonce.len() != 64
        || !valid_party(&input.party)
        || !valid_contract_id(&input.contract_id)
        || cookie(&headers, CHALLENGE).as_deref() != Some(input.nonce.as_str())
    {
        return Err(invalid());
    }
    let challenge_hash = hash(&input.nonce);
    let load = |row: sqlx::postgres::PgRow| {
        use sqlx::Row;
        Pending {
            purpose: row.get("purpose"),
            user_id: row.get("user_id"),
            solana_wallet: row.get("solana_wallet"),
        }
    };
    let pending = sqlx::query(PENDING)
        .bind(&challenge_hash)
        .bind(&canton.config.network)
        .bind(&input.party)
        .fetch_optional(&state.pool)
        .await?
        .map(load)
        .ok_or_else(invalid)?;
    let session = auth::current(&state.pool, &headers).await?;
    if pending.user_id.is_some() && session.as_ref().map(|u| &u.id) != pending.user_id.as_ref() {
        return Err(invalid());
    }
    // Read the claim before locking anything: the ledger call can be slow.
    let claim = canton
        .claims
        .claim(&input.contract_id)
        .await
        .map_err(|_| {
            AuthError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Canton ledger is unavailable",
            )
        })?
        .ok_or_else(invalid)?;
    let expected = if pending.purpose == "link" {
        ClaimPurpose::Link
    } else {
        ClaimPurpose::SignIn
    };
    if claim.operator != canton.config.operator
        || claim.party != input.party
        || claim.nonce != input.nonce
        || claim.purpose != expected
        || claim.solana_wallet != pending.solana_wallet
    {
        return Err(invalid());
    }
    let mut tx = state.pool.begin().await?;
    let locked = sqlx::query(concat!(pending_sql!(), " FOR UPDATE"))
        .bind(&challenge_hash)
        .bind(&canton.config.network)
        .bind(&input.party)
        .fetch_optional(&mut *tx)
        .await?;
    // The claim must be created after the challenge was issued, by the ledger's clock.
    let fresh: bool = sqlx::query_scalar(
        "SELECT $1::timestamptz >= created_at - INTERVAL '1 minute' AND $1::timestamptz <= NOW() + INTERVAL '1 minute'
           FROM canton_challenges WHERE challenge_hash=$2",
    )
    .bind(&claim.created_at)
    .bind(&challenge_hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| invalid())?
    .unwrap_or(false);
    if locked.is_none() || !fresh {
        return Err(invalid());
    }
    sqlx::query("UPDATE canton_challenges SET consumed_at=NOW() WHERE challenge_hash=$1")
        .bind(&challenge_hash)
        .execute(&mut *tx)
        .await?;
    let owner: Option<String> = sqlx::query_scalar(
        "SELECT user_id::text FROM canton_accounts WHERE network=$1 AND party=$2 FOR UPDATE",
    )
    .bind(&canton.config.network)
    .bind(&input.party)
    .fetch_optional(&mut *tx)
    .await?;
    match pending.user_id {
        None => {
            let id = match owner {
                Some(id) => {
                    sqlx::query("UPDATE users SET last_login_at=NOW() WHERE id=$1::uuid")
                        .bind(&id)
                        .execute(&mut *tx)
                        .await?;
                    id
                }
                None => {
                    let id: String = sqlx::query_scalar(
                        "INSERT INTO users(wallet_address,last_login_at,verified_at) VALUES(NULL,NOW(),NOW()) RETURNING id::text",
                    )
                    .fetch_one(&mut *tx)
                    .await?;
                    add_party(&mut tx, &canton.config.network, &input.party, &id).await?;
                    id
                }
            };
            let token = auth::start_session(&mut tx, &headers, &id, &challenge_hash).await?;
            let user = load_user(&mut *tx, &id).await?;
            tx.commit().await?;
            Ok(auth::session_response(&state, user, &token))
        }
        Some(me) => {
            match owner {
                None => add_party(&mut tx, &canton.config.network, &input.party, &me).await?,
                Some(owner) if owner == me => {}
                // A Canton-only user of the same party joins this profile.
                Some(other) => auth::merge_canton_user(&mut tx, &other, &me, None).await?,
            }
            let user = load_user(&mut *tx, &me).await?;
            tx.commit().await?;
            let mut response = Json(user).into_response();
            response.headers_mut().append(
                header::SET_COOKIE,
                set_cookie(CHALLENGE, "", 0, state.secure),
            );
            Ok(response)
        }
    }
}

async fn add_party(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    network: &str,
    party: &str,
    user_id: &str,
) -> Result<()> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM canton_accounts WHERE user_id=$1::uuid")
            .bind(user_id)
            .fetch_one(&mut **tx)
            .await?;
    if count >= MAX_PARTIES {
        return Err(AuthError(
            StatusCode::CONFLICT,
            "A profile can link at most 5 Canton parties",
        ));
    }
    sqlx::query("INSERT INTO canton_accounts(network,party,user_id) VALUES($1,$2,$3::uuid)")
        .bind(network)
        .bind(party)
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Removes a linked party. The last way to sign in cannot be removed.
async fn unlink(
    State(state): State<AuthState>,
    headers: HeaderMap,
    Json(input): Json<UnlinkInput>,
) -> Result<Response> {
    check_origin(&state, &headers)?;
    let canton = canton(&state)?;
    let user = auth::current(&state.pool, &headers)
        .await?
        .ok_or_else(signed_out)?;
    if !user.parties.contains(&input.party) {
        return Err(AuthError(
            StatusCode::NOT_FOUND,
            "That party is not linked to your profile",
        ));
    }
    if user.wallet.is_none() && user.parties.len() == 1 {
        return Err(AuthError(
            StatusCode::CONFLICT,
            "This is your only way to sign in; link a Solana wallet or another party first",
        ));
    }
    sqlx::query("DELETE FROM canton_accounts WHERE network=$1 AND party=$2 AND user_id=$3::uuid")
        .bind(&canton.config.network)
        .bind(&input.party)
        .bind(&user.id)
        .execute(&state.pool)
        .await?;
    Ok(Json(load_user(&state.pool, &user.id).await?).into_response())
}

pub fn routes() -> Router<AuthState> {
    Router::new()
        .route("/auth/canton/challenge", post(challenge))
        .route("/auth/canton/verify", post(verify))
        .route("/auth/canton/unlink", post(unlink))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canton::{BoxFuture, Claim};
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use sqlx::PgPool;
    use std::{collections::HashMap, sync::Mutex};
    use tower::ServiceExt;

    const ORIGIN: &str = "http://localhost:3000";
    const OPERATOR: &str = "operator::1220abcdef";
    const ALICE: &str =
        "alice::1220aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const BOB: &str = "bob::1220aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";
    const WALLET: &str = "AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL";

    #[derive(Default)]
    struct Ledger(Mutex<HashMap<String, Claim>>);
    impl ClaimSource for Ledger {
        fn claim<'a>(
            &'a self,
            id: &'a str,
        ) -> BoxFuture<'a, std::result::Result<Option<Claim>, String>> {
            Box::pin(async move { Ok(self.0.lock().unwrap().get(id).cloned()) })
        }
    }

    struct Harness {
        app: Router,
        ledger: Arc<Ledger>,
        pool: PgPool,
        next: u8,
    }

    impl Harness {
        fn new(pool: PgPool) -> Self {
            let ledger = Arc::new(Ledger::default());
            let mut state = auth::state(pool.clone(), ORIGIN).unwrap();
            state.canton = Some(CantonAuth {
                config: CantonConfig {
                    json_api_url: "http://127.0.0.1:1".into(),
                    read_token: "t".into(),
                    operator: OPERATOR.into(),
                    package_id: "a".repeat(64),
                    network: "canton:testnet".into(),
                },
                claims: ledger.clone(),
            });
            Self {
                app: auth::router(state),
                ledger,
                pool,
                next: 1,
            }
        }

        async fn post(
            &self,
            path: &str,
            body: serde_json::Value,
            cookies: &str,
        ) -> (StatusCode, Vec<String>, serde_json::Value) {
            let response = self
                .app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .method("POST")
                        .header("content-type", "application/json")
                        .header("origin", ORIGIN)
                        .header("cookie", cookies)
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let set = response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .map(|h| h.to_str().unwrap().split(';').next().unwrap().to_owned())
                .collect();
            let body = to_bytes(response.into_body(), 65536).await.unwrap();
            (
                status,
                set,
                serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
            )
        }

        /// Asks for a challenge, "creates" the claim on the fake ledger (with
        /// `tamper` applied) and verifies it. Returns status, cookies, body.
        async fn claim(
            &mut self,
            party: &str,
            purpose: &str,
            session: &str,
            tamper: impl FnOnce(&mut Claim),
        ) -> (StatusCode, Vec<String>, serde_json::Value) {
            let (status, cookies, doc) = self
                .post(
                    "/auth/canton/challenge",
                    serde_json::json!({"party": party, "purpose": purpose}),
                    session,
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{doc}");
            let nonce = doc["nonce"].as_str().unwrap().to_owned();
            let now: String = sqlx::query_scalar(
                "SELECT to_char(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')",
            )
            .fetch_one(&self.pool)
            .await
            .unwrap();
            let mut claim = Claim {
                operator: doc["operator"].as_str().unwrap().into(),
                party: party.into(),
                purpose: if purpose == "link" {
                    ClaimPurpose::Link
                } else {
                    ClaimPurpose::SignIn
                },
                nonce: nonce.clone(),
                solana_wallet: doc["solanaWallet"].as_str().map(str::to_owned),
                created_at: now,
            };
            tamper(&mut claim);
            let id = format!("{:02x}", self.next).repeat(40);
            self.next += 1;
            self.ledger.0.lock().unwrap().insert(id.clone(), claim);
            let cookie = format!("{}; {session}", cookies[0]);
            self.post(
                "/auth/canton/verify",
                serde_json::json!({"party": party, "nonce": nonce, "contractId": id}),
                &cookie,
            )
            .await
        }
    }

    impl Harness {
        /// Moves issued challenges out of the one-minute rate window.
        async fn age(&self) {
            sqlx::query("UPDATE canton_challenges SET created_at=created_at-INTERVAL '2 minutes'")
                .execute(&self.pool)
                .await
                .unwrap();
        }
    }

    fn session(cookies: &[String]) -> String {
        cookies
            .iter()
            .find(|c| c.starts_with("outcomia_session="))
            .unwrap()
            .clone()
    }

    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn canton_sign_in_link_merge_and_unlink(pool: PgPool) {
        let mut h = Harness::new(pool.clone());
        // Claims that do not match the challenge are refused.
        let (status, ..) = h
            .claim(ALICE, "signIn", "", |c| c.nonce = "0".repeat(64))
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, ..) = h
            .claim(ALICE, "signIn", "", |c| c.operator = "other::1220ab".into())
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, ..) = h.claim(ALICE, "signIn", "", |c| c.party = BOB.into()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, ..) = h
            .claim(ALICE, "signIn", "", |c| {
                c.created_at = "2020-01-01T00:00:00Z".into()
            })
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        h.age().await;

        // Alice signs in with Canton only: a new user with no wallet.
        let (status, cookies, user) = h.claim(ALICE, "signIn", "", |_| {}).await;
        assert_eq!(status, StatusCode::OK, "{user}");
        assert_eq!(user["wallet"], serde_json::Value::Null);
        assert_eq!(user["parties"][0], ALICE);
        let alice = session(&cookies);
        // Signing in again finds the same user.
        let (_, _, again) = h.claim(ALICE, "signIn", "", |_| {}).await;
        assert_eq!(again["id"], user["id"]);
        // A Canton-only user cannot start a party link (no Solana wallet to name)
        // and cannot remove its only way to sign in.
        let (status, _, _) = h
            .post(
                "/auth/canton/challenge",
                serde_json::json!({"party": BOB, "purpose": "link"}),
                &alice,
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _, _) = h
            .post(
                "/auth/canton/unlink",
                serde_json::json!({"party": ALICE}),
                &alice,
            )
            .await;
        assert_eq!(status, StatusCode::CONFLICT);
        sqlx::query("INSERT INTO profiles(user_id,wallet,username) VALUES($1::uuid,NULL,'alice')")
            .bind(user["id"].as_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();

        // A Solana user links Bob, then Alice's party: Alice's Canton-only user
        // and its profile merge in.
        let solana: String = sqlx::query_scalar(
            "INSERT INTO users(wallet_address,verified_at) VALUES($1,NOW()) RETURNING id::text",
        )
        .bind(WALLET)
        .fetch_one(&pool)
        .await
        .unwrap();
        let token = auth::random();
        sqlx::query("INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES($1,$2::uuid,NOW()+INTERVAL '1 day')")
            .bind(hash(&token))
            .bind(&solana)
            .execute(&pool)
            .await
            .unwrap();
        let sol = format!("outcomia_session={token}");
        // The link claim must name the signed-in wallet.
        let (status, ..) = h.claim(BOB, "link", &sol, |c| c.solana_wallet = None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, linked) = h.claim(BOB, "link", &sol, |_| {}).await;
        assert_eq!(status, StatusCode::OK, "{linked}");
        assert_eq!(linked["parties"], serde_json::json!([BOB]));
        let (status, _, merged) = h.claim(ALICE, "link", &sol, |_| {}).await;
        assert_eq!(status, StatusCode::OK, "{merged}");
        assert_eq!(merged["id"], solana.as_str());
        assert_eq!(merged["parties"].as_array().unwrap().len(), 2);
        let (owner, wallet): (String, Option<String>) =
            sqlx::query_as("SELECT user_id::text,wallet FROM profiles WHERE username='alice'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            (owner.as_str(), wallet.as_deref()),
            (solana.as_str(), Some(WALLET))
        );
        let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(users, 1, "the Canton-only user was merged away");
        // With a wallet, a party can be unlinked.
        let (status, _, after) = h
            .post(
                "/auth/canton/unlink",
                serde_json::json!({"party": BOB}),
                &sol,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(after["parties"], serde_json::json!([ALICE]));
    }
}
