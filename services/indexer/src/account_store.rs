//! A complete contextual scan becomes one atomic, queryable revision.
use crate::account_data::{decode_account, IDL_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_pubkey::Pubkey;
use sqlx::{types::Json, PgPool, Row};
use std::{collections::HashSet, error::Error, io, str::FromStr};
type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Debug)]
pub struct AccountRow {
    pub address: String,
    pub kind: String,
    pub data: Value,
    pub raw: String,
    pub lamports: String,
}
#[derive(Debug)]
pub struct Snapshot {
    pub slot: i64,
    pub rows: Vec<AccountRow>,
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
pub fn parse_snapshot(value: Value, program: &str) -> Result<Snapshot> {
    let slot = i64::try_from(
        value
            .pointer("/context/slot")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid("missing account context slot"))?,
    )?;
    let accounts = value["value"]
        .as_array()
        .ok_or_else(|| invalid("missing program accounts"))?;
    if accounts.len() > 50000 {
        return Err(invalid("program scan exceeds 50000-account limit").into());
    }
    let mut seen = HashSet::new();
    let mut rows = Vec::with_capacity(accounts.len());
    for record in accounts {
        let address = record["pubkey"]
            .as_str()
            .ok_or_else(|| invalid("account address"))?;
        Pubkey::from_str(address)?;
        if !seen.insert(address.to_owned()) {
            return Err(invalid("duplicate program account").into());
        }
        let account = &record["account"];
        if account["owner"].as_str() != Some(program) || account["executable"] != false {
            return Err(invalid("invalid program account owner").into());
        }
        if account["data"][1] != "base64" {
            return Err(invalid("unexpected account encoding").into());
        }
        let raw = account["data"][0]
            .as_str()
            .ok_or_else(|| invalid("account data"))?;
        let (kind, data) = decode_account(&STANDARD.decode(raw)?)?;
        rows.push(AccountRow {
            address: address.to_owned(),
            kind,
            data,
            raw: raw.to_owned(),
            lamports: account["lamports"]
                .as_u64()
                .ok_or_else(|| invalid("account lamports"))?
                .to_string(),
        });
    }
    Ok(Snapshot { slot, rows })
}
pub async fn bind_identity(pool: &PgPool, genesis: &str, program: &str) -> Result<()> {
    let hash = format!("{:x}", Sha256::digest(IDL_BYTES.as_bytes()));
    sqlx::query("INSERT INTO indexer_identity(singleton,genesis_hash,program_id,idl_hash) VALUES(TRUE,$1,$2,$3) ON CONFLICT DO NOTHING")
        .bind(genesis).bind(program).bind(&hash).execute(pool).await?;
    let row = sqlx::query(
        "SELECT genesis_hash,program_id,idl_hash FROM indexer_identity WHERE singleton",
    )
    .fetch_one(pool)
    .await?;
    if row.get::<String, _>("genesis_hash") != genesis
        || row.get::<String, _>("program_id") != program
        || row.get::<String, _>("idl_hash") != hash
    {
        return Err(invalid(
            "database network/program/IDL identity mismatch; explicit migration required",
        )
        .into());
    }
    Ok(())
}
pub async fn apply(pool: &PgPool, commitment: &str, snapshot: Snapshot) -> Result<i64> {
    let mut tx = pool.begin().await?;
    let state =
        sqlx::query("SELECT slot,revision FROM account_sync WHERE commitment=$1 FOR UPDATE")
            .bind(commitment)
            .fetch_one(&mut *tx)
            .await?;
    if commitment == "finalized" && snapshot.slot < state.get::<i64, _>("slot") {
        return Err(invalid("finalized account scan moved backwards").into());
    }
    let revision = state
        .get::<i64, _>("revision")
        .checked_add(1)
        .ok_or_else(|| invalid("revision overflow"))?;
    for row in snapshot.rows {
        sqlx::query("INSERT INTO indexed_accounts(commitment,address,account_type,data,raw_base64,lamports,slot,revision,deleted) VALUES($1,$2,$3,$4,$5,$6::text::numeric,$7,$8,FALSE) ON CONFLICT(commitment,address) DO UPDATE SET account_type=EXCLUDED.account_type,data=EXCLUDED.data,raw_base64=EXCLUDED.raw_base64,lamports=EXCLUDED.lamports,slot=EXCLUDED.slot,revision=EXCLUDED.revision,deleted=FALSE")
            .bind(commitment).bind(row.address).bind(row.kind).bind(Json(row.data)).bind(row.raw).bind(row.lamports).bind(snapshot.slot).bind(revision).execute(&mut *tx).await?;
    }
    // A failed/truncated scan never reaches this function. Absence in a complete
    // bank-context scan can tombstone a closed account without guessing its action.
    sqlx::query("UPDATE indexed_accounts SET deleted=TRUE,slot=$2,revision=$3 WHERE commitment=$1 AND revision<>$3 AND NOT deleted")
        .bind(commitment).bind(snapshot.slot).bind(revision).execute(&mut *tx).await?;
    sqlx::query("UPDATE account_sync SET slot=$2,revision=$3,observed_at=NOW(),ready=TRUE,last_error=NULL WHERE commitment=$1")
        .bind(commitment).bind(snapshot.slot).bind(revision).execute(&mut *tx).await?;
    sqlx::query("SELECT pg_notify('outcomia_revisions',$1)")
        .bind(format!("{commitment}:{revision}"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(revision)
}
pub async fn failed(pool: &PgPool, commitment: &str, message: &str) {
    let _ = sqlx::query("UPDATE account_sync SET ready=FALSE,last_error=$2 WHERE commitment=$1")
        .bind(commitment)
        .bind({
            let _ = message;
            "Account ingestion is unavailable; reconnecting"
        })
        .execute(pool)
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(n: u8) -> AccountRow {
        AccountRow {
            address: bs58::encode([n; 32]).into_string(),
            kind: "AssetBalance".into(),
            data: serde_json::json!({"owner":"owner","free":u64::MAX.to_string()}),
            raw: "AQ==".into(),
            lamports: u64::MAX.to_string(),
        }
    }
    #[test]
    fn rejects_unknown_context_or_incomplete_data() {
        assert!(parse_snapshot(serde_json::json!({"value":[]}), "program").is_err());
        assert!(parse_snapshot(
            serde_json::json!({"context":{"slot":1},"value":[{"pubkey":"bad"}]}),
            "program"
        )
        .is_err());
    }
    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn revisions_close_missing_accounts_and_keep_commitments_separate(pool: PgPool) {
        apply(
            &pool,
            "confirmed",
            Snapshot {
                slot: 20,
                rows: vec![row(1), row(2)],
            },
        )
        .await
        .unwrap();
        apply(
            &pool,
            "finalized",
            Snapshot {
                slot: 15,
                rows: vec![row(1)],
            },
        )
        .await
        .unwrap();
        apply(
            &pool,
            "confirmed",
            Snapshot {
                slot: 19,
                rows: vec![row(2)],
            },
        )
        .await
        .unwrap();
        let rows: Vec<(String, bool)> = sqlx::query_as(
            "SELECT commitment,deleted FROM indexed_accounts WHERE address=$1 ORDER BY commitment",
        )
        .bind(row(1).address)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows,
            vec![("confirmed".into(), true), ("finalized".into(), false)]
        );
        assert!(apply(
            &pool,
            "finalized",
            Snapshot {
                slot: 14,
                rows: vec![]
            }
        )
        .await
        .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT lamports::text FROM indexed_accounts LIMIT 1")
                .fetch_one(&pool)
                .await
                .unwrap(),
            u64::MAX.to_string()
        );
        bind_identity(&pool, "devnet", "program").await.unwrap();
        assert!(bind_identity(&pool, "other", "program").await.is_err());
    }
}
