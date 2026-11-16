//! Bounded, shared discovery of external assets for authenticated tracked wallets.
use serde_json::{json, Value};
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::request::RpcRequest;
use sqlx::PgPool;
use std::{collections::BTreeMap, error::Error, sync::Arc, time::Duration};
const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
#[derive(Debug)]
struct Holding {
    mint: String,
    program: String,
    amount: u64,
    frozen: u64,
    decimals: i16,
    count: i32,
    slot: i64,
}
fn parse(owner: &str, balance: Value, tokens: Value) -> Result<Vec<Holding>> {
    let slot = |v: &Value| -> Result<i64> {
        Ok(i64::try_from(
            v["context"]["slot"]
                .as_u64()
                .ok_or("missing wallet context")?,
        )?)
    };
    let mut holdings = BTreeMap::<String, Holding>::new();
    let accounts = tokens["value"]
        .as_array()
        .ok_or("missing wallet token accounts")?;
    if accounts.len() > 1000 {
        return Err("wallet token account limit exceeded".into());
    }
    for row in accounts {
        let info = &row["account"]["data"]["parsed"]["info"];
        if row["account"]["owner"] != TOKEN || info["owner"] != owner {
            return Err("wallet token ownership mismatch".into());
        }
        let mint = info["mint"].as_str().ok_or("missing token mint")?;
        let amount = info["tokenAmount"]["amount"]
            .as_str()
            .ok_or("missing exact token amount")?
            .parse::<u64>()?;
        let decimals = i16::try_from(
            info["tokenAmount"]["decimals"]
                .as_u64()
                .ok_or("missing decimals")?,
        )?;
        if !(0..=255).contains(&decimals)
            || !matches!(info["state"].as_str(), Some("initialized" | "frozen"))
        {
            return Err("invalid token state".into());
        }
        let entry = holdings.entry(mint.to_owned()).or_insert(Holding {
            mint: mint.into(),
            program: TOKEN.into(),
            amount: 0,
            frozen: 0,
            decimals,
            count: 0,
            slot: slot(&tokens)?,
        });
        if entry.decimals != decimals {
            return Err("conflicting token decimals".into());
        }
        entry.amount = entry
            .amount
            .checked_add(amount)
            .ok_or("token holdings overflow")?;
        if info["state"] == "frozen" {
            entry.frozen = entry
                .frozen
                .checked_add(amount)
                .ok_or("frozen holdings overflow")?;
        }
        entry.count += 1;
    }
    let mut values: Vec<_> = holdings.into_values().collect();
    values.push(Holding {
        mint: "NATIVE_SOL".into(),
        program: "11111111111111111111111111111111".into(),
        amount: balance["value"].as_u64().ok_or("missing SOL balance")?,
        frozen: 0,
        decimals: 9,
        count: 1,
        slot: slot(&balance)?,
    });
    Ok(values)
}
async fn refresh(pool: &PgPool, client: Arc<RpcClient>, owner: &str, level: &str) -> Result<()> {
    let wallet = owner.to_owned();
    let commitment = level.to_owned();
    let (sol, tokens) = tokio::task::spawn_blocking(move || {
        let sol: Value = client.send(
            RpcRequest::GetBalance,
            json!([wallet,{"commitment":commitment}]),
        )?;
        let tokens: Value = client.send(
            RpcRequest::GetTokenAccountsByOwner,
            json!([wallet,{"programId":TOKEN},{"commitment":commitment,"encoding":"jsonParsed"}]),
        )?;
        Ok::<_, Box<dyn Error + Send + Sync>>((sol, tokens))
    })
    .await??;
    let holdings = parse(owner, sol, tokens)?;
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM wallet_assets WHERE owner=$1 AND commitment=$2")
        .bind(owner)
        .bind(level)
        .execute(&mut *tx)
        .await?;
    for h in holdings {
        sqlx::query("INSERT INTO wallet_assets(commitment,owner,mint,token_program,amount,frozen,decimals,account_count,slot) VALUES($1,$2,$3,$4,$5::text::numeric,$6::text::numeric,$7,$8,$9)")
            .bind(level).bind(owner).bind(h.mint).bind(h.program).bind(h.amount.to_string()).bind(h.frozen.to_string()).bind(h.decimals).bind(h.count).bind(h.slot).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO wallet_sync(commitment,owner,observed_at,ready) VALUES($1,$2,NOW(),TRUE) ON CONFLICT(commitment,owner) DO UPDATE SET observed_at=NOW(),ready=TRUE,last_error=NULL").bind(level).bind(owner).execute(&mut *tx).await?;
    sqlx::query("SELECT pg_notify('outcomia_revisions',$1)")
        .bind(format!("wallet:{owner}"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn run(pool: PgPool, client: Arc<RpcClient>) {
    loop {
        // A rotating two-wallet batch bounds upstream work even under many logins.
        let wallets:std::result::Result<Vec<String>,_>=sqlx::query_scalar("SELECT w.owner FROM tracked_wallets w LEFT JOIN wallet_sync s ON s.owner=w.owner AND s.commitment='confirmed' WHERE w.requested_at>NOW()-INTERVAL '30 minutes' AND (s.observed_at IS NULL OR s.observed_at<NOW()-INTERVAL '20 seconds') ORDER BY s.observed_at NULLS FIRST LIMIT 2").fetch_all(&pool).await;
        if let Ok(wallets) = wallets {
            for owner in wallets {
                for level in ["confirmed", "finalized"] {
                    if let Err(error) = refresh(&pool, Arc::clone(&client), &owner, level).await {
                        eprintln!("Wallet holdings unavailable: {error}");
                        let _=sqlx::query("INSERT INTO wallet_sync(commitment,owner,observed_at,ready,last_error) VALUES($1,$2,NOW(),FALSE,$3) ON CONFLICT(commitment,owner) DO UPDATE SET observed_at=NOW(),ready=FALSE,last_error=EXCLUDED.last_error").bind(level).bind(&owner).bind(error.to_string()).execute(&pool).await;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aggregates_non_associated_and_frozen_accounts_without_rounding() {
        let row = |state: &str| json!({"account":{"owner":TOKEN,"data":{"parsed":{"info":{"owner":"owner","mint":"mint","state":state,"tokenAmount":{"amount":"9007199254740993","decimals":6}}}}}});
        let tokens = json!({"context":{"slot":9},"value":[row("initialized"),row("frozen")]});
        let values = parse("owner", json!({"context":{"slot":10},"value":17}), tokens).unwrap();
        assert_eq!(values[0].amount, 18014398509481986);
        assert_eq!(values[0].frozen, 9007199254740993);
        assert_eq!(values[0].count, 2);
        assert_eq!(values[1].mint, "NATIVE_SOL");
    }
}
