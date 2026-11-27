//! Reads `Outcomia.Profiles:ProfileClaim` contracts from a Canton participant,
//! so a party can prove it controls itself without a message-signing standard.
//! The token is a read-only operator credential; nothing is submitted.
use serde_json::{json, Value};
use std::{env, future::Future, pin::Pin, sync::Arc, time::Duration};

/// Canton settings; all present or Canton sign-in and linking are off.
#[derive(Clone, Debug)]
pub struct CantonConfig {
    /// Ledger JSON API base URL: HTTPS, or HTTP on loopback only.
    pub json_api_url: String,
    pub read_token: String,
    /// Party that observes every claim (the Outcomia operator).
    pub operator: String,
    /// Package id holding `Outcomia.Profiles`.
    pub package_id: String,
    /// Network label stored with linked parties, e.g. `canton:testnet`.
    pub network: String,
}

impl CantonConfig {
    /// Returns: `Ok(None)` when no Canton variable is set. Errors: a partial or
    /// malformed configuration, which must not silently disable checks.
    pub fn from_env() -> Result<Option<Self>, String> {
        let get = |name: &str| env::var(name).ok().filter(|v| !v.trim().is_empty());
        let values = [
            get("CANTON_JSON_API_URL"),
            get("CANTON_READ_TOKEN"),
            get("CANTON_OPERATOR_PARTY"),
            get("CANTON_PROFILES_PACKAGE_ID"),
            get("CANTON_NETWORK"),
        ];
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        let [Some(url), Some(token), Some(operator), Some(package_id), Some(network)] = values
        else {
            return Err("Set all of CANTON_JSON_API_URL, CANTON_READ_TOKEN, CANTON_OPERATOR_PARTY, CANTON_PROFILES_PACKAGE_ID and CANTON_NETWORK, or none".into());
        };
        let config = Self {
            json_api_url: url.trim_end_matches('/').to_owned(),
            read_token: token,
            operator,
            package_id,
            network,
        };
        config.validate()?;
        Ok(Some(config))
    }

    fn validate(&self) -> Result<(), String> {
        let uri = axum::http::Uri::try_from(self.json_api_url.as_str())
            .map_err(|_| "CANTON_JSON_API_URL is not a URL")?;
        let local = matches!(uri.host(), Some("localhost" | "127.0.0.1" | "[::1]"));
        match uri.scheme_str() {
            Some("https") => {}
            Some("http") if local => {}
            _ => return Err("CANTON_JSON_API_URL must be HTTPS (HTTP only on loopback)".into()),
        }
        if !valid_party(&self.operator) {
            return Err("CANTON_OPERATOR_PARTY is not a Canton party id".into());
        }
        if self.package_id.len() != 64 || !self.package_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("CANTON_PROFILES_PACKAGE_ID must be a 64-character package id".into());
        }
        if self.network.len() > 64 || !self.network.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("CANTON_NETWORK must be a short label such as canton:testnet".into());
        }
        Ok(())
    }

    pub fn template_id(&self) -> String {
        format!("{}:Outcomia.Profiles:ProfileClaim", self.package_id)
    }
}

/// `name::fingerprint`: a hint of letters, digits and `-_:` and a hex
/// namespace fingerprint. Checks shape only; the ledger is the authority.
pub fn valid_party(value: &str) -> bool {
    let Some((hint, fingerprint)) = value.rsplit_once("::") else {
        return false;
    };
    value.len() <= 255
        && !hint.is_empty()
        && hint
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'))
        && (8..=136).contains(&fingerprint.len())
        && fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Opaque Canton contract id: hex, as the ledger issues it.
pub fn valid_contract_id(value: &str) -> bool {
    (66..=512).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClaimPurpose {
    SignIn,
    Link,
}

/// An active claim as the ledger reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub operator: String,
    pub party: String,
    pub purpose: ClaimPurpose,
    pub nonce: String,
    pub solana_wallet: Option<String>,
    /// The ledger's creation time (RFC 3339), not a client-supplied value.
    pub created_at: String,
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Looks up one active claim by contract id; `None` when it is not active
/// or not a claim. Tests substitute a fixed source.
pub trait ClaimSource: Send + Sync {
    fn claim<'a>(&'a self, contract_id: &'a str) -> BoxFuture<'a, Result<Option<Claim>, String>>;
}

/// Reads claims through the Ledger JSON API v2 as the operator.
pub struct LedgerClaims {
    config: CantonConfig,
    http: reqwest::Client,
}

impl LedgerClaims {
    pub fn new(config: CantonConfig) -> Result<Arc<Self>, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Canton HTTP client could not start")?;
        Ok(Arc::new(Self { config, http }))
    }

    async fn request(&self, path: &str, body: Option<Value>) -> Result<Value, String> {
        let url = format!("{}{path}", self.config.json_api_url);
        let request = match body {
            Some(body) => self.http.post(url).json(&body),
            None => self.http.get(url),
        };
        let response = request
            .bearer_auth(&self.config.read_token)
            .send()
            .await
            .map_err(|_| "Canton ledger is unreachable")?;
        if !response.status().is_success() {
            return Err("Canton ledger refused the read".into());
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "Canton ledger read failed")?;
        if bytes.len() > 2_000_000 {
            return Err("Canton ledger response is too large".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Canton ledger returned invalid JSON".into())
    }
}

impl ClaimSource for LedgerClaims {
    fn claim<'a>(&'a self, contract_id: &'a str) -> BoxFuture<'a, Result<Option<Claim>, String>> {
        Box::pin(async move {
            let end = self.request("/v2/state/ledger-end", None).await?;
            let offset = end
                .get("offset")
                .cloned()
                .ok_or("Canton ledger end is missing")?;
            let template = self.config.template_id();
            let body = json!({
                "eventFormat": {
                    "filtersByParty": {
                        (self.config.operator.clone()): {
                            "cumulative": [{
                                "identifierFilter": {
                                    "TemplateFilter": {
                                        "value": { "templateId": template, "includeCreatedEventBlob": false }
                                    }
                                }
                            }]
                        }
                    },
                    "verbose": true
                },
                "activeAtOffset": offset
            });
            let rows = self
                .request("/v2/state/active-contracts", Some(body))
                .await?;
            find_claim(&rows, &template, contract_id)
        })
    }
}

/// Picks `contract_id` out of an active-contracts response and decodes it.
/// Errors: a matching row that is not a well-formed claim.
pub fn find_claim(
    rows: &Value,
    template: &str,
    contract_id: &str,
) -> Result<Option<Claim>, String> {
    let rows = rows
        .as_array()
        .or_else(|| rows.get("items").and_then(Value::as_array))
        .ok_or("Unexpected Canton ledger response")?;
    for row in rows {
        let entry = row.get("contractEntry").unwrap_or(row);
        let active = entry
            .get("JsActiveContract")
            .or_else(|| entry.get("activeContract"))
            .unwrap_or(entry);
        let Some(event) = active.get("createdEvent") else {
            continue;
        };
        if event.get("contractId").and_then(Value::as_str) != Some(contract_id) {
            continue;
        }
        if event.get("templateId").and_then(Value::as_str) != Some(template) {
            return Ok(None);
        }
        let bad = || "Malformed profile claim".to_string();
        let args = event.get("createArgument").ok_or_else(bad)?;
        let text = |key: &str| {
            args.get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(bad)
        };
        let purpose = match args.get("purpose").and_then(Value::as_str) {
            Some("ClaimSignIn") => ClaimPurpose::SignIn,
            Some("ClaimLink") => ClaimPurpose::Link,
            _ => return Err(bad()),
        };
        let solana_wallet = match args.get("solanaWallet") {
            None | Some(Value::Null) => None,
            Some(Value::String(w)) => Some(w.clone()),
            Some(_) => return Err(bad()),
        };
        return Ok(Some(Claim {
            operator: text("operator")?,
            party: text("party")?,
            purpose,
            nonce: text("nonce")?,
            solana_wallet,
            created_at: event
                .get("createdAt")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(bad)?,
        }));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARTY: &str =
        "alice::1220aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

    #[test]
    fn party_and_contract_shapes() {
        assert!(valid_party(PARTY));
        assert!(valid_party("Outcomia-op_1::abcdef0123"));
        for bad in [
            "alice",
            "::1220ab",
            "al ice::1220abcdef",
            "alice::xyz12345",
            "alice::12",
        ] {
            assert!(!valid_party(bad), "{bad}");
        }
        assert!(valid_contract_id(&"00".repeat(40)));
        assert!(!valid_contract_id("00zz"));
    }

    #[test]
    fn decodes_the_matching_claim_only() {
        let template = format!("{}:Outcomia.Profiles:ProfileClaim", "a".repeat(64));
        let event = |cid: &str, tid: &str, purpose: &str, wallet: Value| {
            json!({"contractEntry": {"JsActiveContract": {"createdEvent": {
                "contractId": cid, "templateId": tid, "createdAt": "2026-11-27T10:00:00Z",
                "createArgument": {"operator": "op::abcdef0123", "party": PARTY, "purpose": purpose,
                  "nonce": "0".repeat(64), "solanaWallet": wallet}}}}})
        };
        let cid = "00".repeat(40);
        let rows = json!([
            event(&"11".repeat(40), &template, "ClaimSignIn", Value::Null),
            event(
                &cid,
                &template,
                "ClaimLink",
                json!("AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL")
            ),
        ]);
        let claim = find_claim(&rows, &template, &cid).unwrap().unwrap();
        assert_eq!(claim.purpose, ClaimPurpose::Link);
        assert_eq!(claim.party, PARTY);
        assert_eq!(
            claim.solana_wallet.as_deref(),
            Some("AG4ztZvcZjzFKjoXLzH8M6U3if9CwVFTXH2FHjqg7SdL")
        );
        assert_eq!(
            find_claim(&rows, &template, &"22".repeat(40)).unwrap(),
            None
        );
        // Another template with the same id is not a claim.
        let other = json!([event(&cid, "x:Other:T", "ClaimSignIn", Value::Null)]);
        assert_eq!(find_claim(&other, &template, &cid).unwrap(), None);
        let malformed = json!([event(&cid, &template, "Nope", Value::Null)]);
        assert!(find_claim(&malformed, &template, &cid).is_err());
    }
}
