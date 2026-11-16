//! Ordered instruction replay supplies fills missing from the program event catalog.
use crate::{
    account_data::{camel, decode_instruction, idl},
    rpc::{fetch_transaction, transaction_position, SignatureRecord},
    storage::persist_transaction,
};
use serde_json::{json, Map, Value};
use solana_pubkey::Pubkey;
use solana_rpc_client::rpc_client::RpcClient;
use sqlx::{types::Json, PgPool, Row};
use std::{error::Error, sync::Arc, time::Duration};
type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
#[derive(Debug)]
struct Instruction {
    index: i32,
    name: String,
    args: Value,
    accounts: Value,
}
fn parse(body: &Value, program: &str) -> Result<Vec<Instruction>> {
    let message = &body["transaction"]["message"];
    let mut keys: Vec<String> = message["accountKeys"]
        .as_array()
        .ok_or("missing transaction keys")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or("unsupported transaction keys")
        })
        .collect::<std::result::Result<_, _>>()?;
    for field in ["writable", "readonly"] {
        if let Some(loaded) = body["meta"]["loadedAddresses"][field].as_array() {
            for key in loaded {
                keys.push(key.as_str().ok_or("invalid loaded key")?.into());
            }
        }
    }
    let mut output = vec![];
    let mut decode = |instruction: &Value, index: i32| -> Result<()> {
        let program_index = instruction["programIdIndex"]
            .as_u64()
            .ok_or("missing instruction program")? as usize;
        if keys
            .get(program_index)
            .ok_or("invalid instruction program index")?
            != program
        {
            return Ok(());
        }
        let bytes = bs58::decode(
            instruction["data"]
                .as_str()
                .ok_or("missing instruction data")?,
        )
        .into_vec()?;
        let (name, args) = decode_instruction(&bytes)?;
        let definition = idl()["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["name"] == name)
            .unwrap();
        let indexes = instruction["accounts"]
            .as_array()
            .ok_or("missing instruction accounts")?;
        let roles = definition["accounts"].as_array().unwrap();
        if indexes.len() < roles.len() {
            return Err("truncated instruction account list".into());
        }
        let mut accounts = Map::new();
        for (role, key) in roles.iter().zip(indexes) {
            let key = keys
                .get(key.as_u64().ok_or("invalid instruction key")? as usize)
                .ok_or("invalid account index")?;
            accounts.insert(
                camel(
                    role["name"]
                        .as_str()
                        .ok_or("grouped instruction accounts unsupported")?,
                ),
                json!(key),
            );
        }
        output.push(Instruction {
            index,
            name,
            args,
            accounts: Value::Object(accounts),
        });
        Ok(())
    };
    let instructions = message["instructions"]
        .as_array()
        .ok_or("missing compiled instructions")?;
    for (index, instruction) in instructions.iter().enumerate() {
        let base = i32::try_from(index)?
            .checked_mul(1000)
            .ok_or("instruction index overflow")?;
        decode(instruction, base)?;
        if let Some(groups) = body["meta"]["innerInstructions"].as_array() {
            for group in groups {
                if group["index"].as_u64() == Some(index as u64) {
                    for (inner, instruction) in group["instructions"]
                        .as_array()
                        .ok_or("invalid inner instructions")?
                        .iter()
                        .enumerate()
                    {
                        if inner >= 999 {
                            return Err("inner instruction count exceeds bound".into());
                        }
                        decode(instruction, base + inner as i32 + 1)?;
                    }
                }
            }
        }
    }
    Ok(output)
}
async fn enrich(pool: &PgPool, client: Arc<RpcClient>, program: Pubkey) -> Result<bool> {
    let rows=sqlx::query("SELECT t.signature,t.slot,t.block_time,t.transaction_index FROM chain_transactions t LEFT JOIN transaction_execution e USING(signature) WHERE e.signature IS NULL OR t.transaction_index IS NULL ORDER BY t.slot LIMIT 20").fetch_all(pool).await?;
    let any = !rows.is_empty();
    for row in rows {
        let signature: String = row.get("signature");
        let slot = row.get::<i64, _>("slot") as u64;
        let record = SignatureRecord {
            signature: signature.clone(),
            slot,
            block_time: row.get("block_time"),
            transaction_index: row
                .get::<Option<i32>, _>("transaction_index")
                .map(|n| n as u32),
        };
        let rpc = Arc::clone(&client);
        let transaction = tokio::task::spawn_blocking(move || {
            let mut transaction =
                fetch_transaction(&rpc, &record)?.ok_or("finalized execution is unavailable")?;
            if transaction.transaction_index.is_none() {
                transaction.transaction_index = Some(transaction_position(&rpc, &signature, slot)?);
            }
            Ok::<_, Box<dyn Error + Send + Sync>>(transaction)
        })
        .await??;
        let events = crate::events::extract_program_data(&transaction.logs, &program)
            .iter()
            .map(crate::decoder::decode_event)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        persist_transaction(pool, &transaction, &events).await?;
    }
    Ok(any)
}
async fn decode_sources(pool: &PgPool, program: &str) -> Result<bool> {
    let rows=sqlx::query("SELECT e.signature,e.body FROM transaction_execution e LEFT JOIN instruction_decode_state d USING(signature) WHERE d.signature IS NULL LIMIT 100").fetch_all(pool).await?;
    let any = !rows.is_empty();
    for row in rows {
        let signature: String = row.get("signature");
        let instructions = parse(&row.get::<Value, _>("body"), program)?;
        let mut tx = pool.begin().await?;
        for instruction in instructions {
            sqlx::query("INSERT INTO decoded_instructions(signature,execution_index,instruction_name,arguments,accounts) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(&signature).bind(instruction.index).bind(instruction.name).bind(Json(instruction.args)).bind(Json(instruction.accounts)).execute(&mut *tx).await?;
        }
        sqlx::query(
            "INSERT INTO instruction_decode_state(signature) VALUES($1) ON CONFLICT DO NOTHING",
        )
        .bind(signature)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    Ok(any)
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| format!("Missing execution field {key}").into())
}
fn number(value: &Value, key: &str) -> Result<u64> {
    Ok(text(value, key)?.parse()?)
}
fn variant(value: &Value) -> Result<&str> {
    value
        .as_object()
        .and_then(|v| v.keys().next())
        .map(String::as_str)
        .ok_or_else(|| "invalid outcome/side variant".into())
}
fn outcome(value: &Value) -> Result<&str> {
    match variant(value)? {
        "spot" => Ok("spot"),
        "yes" => Ok("0"),
        "no" => Ok("1"),
        _ => Err("invalid execution outcome".into()),
    }
}
async fn replay(pool: &PgPool, client: Arc<RpcClient>) -> Result<()> {
    let complete:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM backfill_checkpoints WHERE completed) AND NOT EXISTS(SELECT 1 FROM chain_transactions t LEFT JOIN instruction_decode_state d USING(signature) WHERE d.signature IS NULL OR t.transaction_index IS NULL)").fetch_one(pool).await?;
    if !complete {
        return Ok(());
    }
    let state = sqlx::query("SELECT * FROM execution_replay_state WHERE singleton")
        .fetch_one(pool)
        .await?;
    let rows=sqlx::query("SELECT i.*,t.slot,t.transaction_index,t.block_time FROM decoded_instructions i JOIN chain_transactions t USING(signature) WHERE (t.slot,t.transaction_index,i.execution_index)>($1,$2,$3) ORDER BY t.slot,t.transaction_index,i.execution_index LIMIT 500")
        .bind(state.get::<i64,_>("slot")).bind(state.get::<i32,_>("transaction_index")).bind(state.get::<i32,_>("execution_index")).fetch_all(pool).await?;
    for row in rows {
        let name: String = row.get("instruction_name");
        let args: Value = row.get("arguments");
        let accounts: Value = row.get("accounts");
        let slot: i64 = row.get("slot");
        // Resolve immutable precision before opening the reducer transaction.
        let decimals = if name == "initialize_market" {
            let mint = text(&accounts, "baseMint")?.to_owned();
            crate::mints::ensure(pool, Arc::clone(&client), vec![mint.clone()], slot).await?;
            Some(
                sqlx::query_scalar::<_, i16>("SELECT decimals FROM mint_cache WHERE address=$1")
                    .bind(mint)
                    .fetch_one(pool)
                    .await?,
            )
        } else {
            None
        };
        let mut tx = pool.begin().await?;
        let state = sqlx::query(
            "SELECT fee_bps,fee_known FROM execution_replay_state WHERE singleton FOR UPDATE",
        )
        .fetch_one(&mut *tx)
        .await?;
        match name.as_str() {
            "initialize_protocol" => {
                sqlx::query(
                    "UPDATE execution_replay_state SET fee_bps=0,fee_known=TRUE WHERE singleton",
                )
                .execute(&mut *tx)
                .await?;
            }
            "set_taker_fee" => {
                let rate = args["takerFeeBps"].as_u64().ok_or("invalid fee rate")?;
                if rate > 1000 {
                    return Err("unsupported historical fee".into());
                }
                sqlx::query(
                    "UPDATE execution_replay_state SET fee_bps=$1,fee_known=TRUE WHERE singleton",
                )
                .bind(rate as i16)
                .execute(&mut *tx)
                .await?;
            }
            "initialize_market" | "initialize_prediction_market" => {
                sqlx::query("INSERT INTO execution_market_info(market,kind,base_decimals) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(text(&accounts,"market")?).bind(if decimals.is_some(){"SPOT"}else{"BINARY"}).bind(decimals.unwrap_or(0)).execute(&mut *tx).await?;
            }
            "place_shared_order"
            | "place_prediction_order"
            | "append_prediction_order"
            | "insert_prediction_order" => {
                let selected = outcome(&args["outcome"])?;
                let engine = if name == "place_shared_order" {
                    if selected == "spot" {
                        "SHARED_SPOT"
                    } else {
                        "SHARED_BINARY"
                    }
                } else {
                    "LEGACY_BINARY"
                };
                sqlx::query("INSERT INTO execution_orders(address,market,engine,outcome,owner,side,price,remaining) VALUES($1,$2,$3,$4,$5,$6,$7::text::numeric,$8::text::numeric)")
                    .bind(text(&accounts,"order")?).bind(text(&accounts,"market")?).bind(engine).bind(selected).bind(text(&accounts,"owner")?).bind(variant(&args["side"])?).bind(text(&args,"price")?).bind(text(&args,"quantity")?).execute(&mut *tx).await?;
            }
            "cancel_shared_order" | "cancel_prediction_order" => {
                let result =
                    sqlx::query("UPDATE execution_orders SET remaining=0 WHERE address=$1")
                        .bind(text(&accounts, "order")?)
                        .execute(&mut *tx)
                        .await?;
                if result.rows_affected() != 1 {
                    return Err("historical cancellation is missing its order placement".into());
                }
            }
            "match_shared_order" | "match_prediction_order" => {
                if !state.get::<bool, _>("fee_known") {
                    return Err("historical fee configuration is missing".into());
                }
                let order=sqlx::query("SELECT *,price::text AS price_text,remaining::text AS remaining_text FROM execution_orders WHERE address=$1 FOR UPDATE").bind(text(&accounts,"makerOrder")?).fetch_optional(&mut *tx).await?.ok_or("historical fill is missing its maker placement")?;
                let market: String = order.get("market");
                let engine: String = order.get("engine");
                let selected: String = order.get("outcome");
                let side = variant(&args["takerSide"])?;
                let price = order.get::<String, _>("price_text").parse::<u64>()?;
                let remaining = order.get::<String, _>("remaining_text").parse::<u64>()?;
                let quantity = remaining.min(number(&args, "quantity")?);
                if quantity == 0
                    || market != text(&accounts, "market")?
                    || selected != outcome(&args["outcome"])?
                    || order.get::<String, _>("side") == side
                {
                    return Err("historical maker context is inconsistent".into());
                }
                let precision: i16 = sqlx::query_scalar(
                    "SELECT base_decimals FROM execution_market_info WHERE market=$1",
                )
                .bind(&market)
                .fetch_one(&mut *tx)
                .await?;
                let scale = 10_u128
                    .checked_pow(u32::try_from(precision)?)
                    .ok_or("historical precision overflow")?;
                let quote = u64::try_from(u128::from(price) * u128::from(quantity) / scale)?;
                let fee = u64::try_from(
                    (u128::from(quote) * u128::try_from(state.get::<i16, _>("fee_bps"))?)
                        .div_ceil(10000),
                )?;
                let signature: String = row.get("signature");
                let index: i32 = row.get("execution_index");
                sqlx::query("INSERT INTO indexed_trades(execution_id,signature,slot,transaction_index,execution_index,block_time,market,engine,outcome,maker,taker,taker_side,price,quantity,quote_atoms,fee_atoms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text::numeric,$14::text::numeric,$15::text::numeric,$16::text::numeric)")
                    .bind(format!("{signature}:ix:{index}")).bind(signature).bind(slot).bind(row.get::<i32,_>("transaction_index")).bind(index).bind(row.get::<Option<i64>,_>("block_time"))
                    .bind(&market).bind(engine).bind(selected).bind(order.get::<String,_>("owner")).bind(text(&accounts,"taker")?).bind(side).bind(price.to_string()).bind(quantity.to_string()).bind(quote.to_string()).bind(fee.to_string()).execute(&mut *tx).await?;
                sqlx::query(
                    "UPDATE execution_orders SET remaining=$2::text::numeric WHERE address=$1",
                )
                .bind(text(&accounts, "makerOrder")?)
                .bind((remaining - quantity).to_string())
                .execute(&mut *tx)
                .await?;
            }
            _ => {}
        }
        sqlx::query("UPDATE execution_replay_state SET slot=$1,transaction_index=$2,execution_index=$3,ready=FALSE,last_error=NULL WHERE singleton").bind(slot).bind(row.get::<i32,_>("transaction_index")).bind(row.get::<i32,_>("execution_index")).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    let remaining:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM decoded_instructions i JOIN chain_transactions t USING(signature),execution_replay_state s WHERE (t.slot,t.transaction_index,i.execution_index)>(s.slot,s.transaction_index,s.execution_index))").fetch_one(pool).await?;
    if !remaining {
        sqlx::query("UPDATE execution_replay_state SET ready=TRUE,last_error=NULL WHERE singleton")
            .execute(pool)
            .await?;
    }
    Ok(())
}
pub async fn run(pool: PgPool, client: Arc<RpcClient>, program: Pubkey) {
    loop {
        let result = async {
            if enrich(&pool, Arc::clone(&client), program).await? {
                return Ok(());
            }
            if decode_sources(&pool, &program.to_string()).await? {
                return Ok(());
            }
            replay(&pool, Arc::clone(&client)).await
        }
        .await;
        if let Err(error) = result {
            eprintln!("Execution replay unavailable: {error}");
            let _=sqlx::query("UPDATE execution_replay_state SET ready=FALSE,last_error='Execution history is incomplete; reconciliation required' WHERE singleton").execute(&pool).await;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn v0_loaded_program_and_inner_instructions_keep_execution_order() {
        let definition = idl()["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "initialize_protocol")
            .unwrap();
        let bytes: Vec<u8> = definition["discriminator"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u8)
            .collect();
        let ix = json!({"programIdIndex":1,"accounts":vec![0;definition["accounts"].as_array().unwrap().len()],"data":bs58::encode(bytes).into_string()});
        let body = json!({"transaction":{"message":{"accountKeys":["owner"],"instructions":[ix.clone()]}},"meta":{"loadedAddresses":{"writable":["program"],"readonly":[]},"innerInstructions":[{"index":0,"instructions":[ix]}]}});
        let decoded = parse(&body, "program").unwrap();
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].index, 0);
        assert_eq!(decoded[1].index, 1);
        assert_eq!(decoded[0].name, "initialize_protocol");
    }
    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn shared_and_binary_history_replays_exactly_once(pool: PgPool) {
        sqlx::query(
            "INSERT INTO backfill_checkpoints(program_id,completed) VALUES('program',TRUE)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO mint_cache(address,owner,raw_base64,decimals) VALUES('mint','token','AA==',6)").execute(&pool).await.unwrap();
        let rows = vec![
            ("initialize_protocol", json!({}), json!({})),
            ("set_taker_fee", json!({"takerFeeBps":25}), json!({})),
            (
                "initialize_market",
                json!({}),
                json!({"market":"spot","baseMint":"mint"}),
            ),
            (
                "place_shared_order",
                json!({"outcome":{"spot":{}},"side":{"ask":{}},"price":"400000","quantity":"9000000"}),
                json!({"market":"spot","order":"maker","owner":"alice"}),
            ),
            (
                "match_shared_order",
                json!({"outcome":{"spot":{}},"takerSide":{"bid":{}},"quantity":"3000000"}),
                json!({"market":"spot","makerOrder":"maker","taker":"bob"}),
            ),
            (
                "match_shared_order",
                json!({"outcome":{"spot":{}},"takerSide":{"bid":{}},"quantity":"9000000"}),
                json!({"market":"spot","makerOrder":"maker","taker":"bob"}),
            ),
            (
                "initialize_prediction_market",
                json!({}),
                json!({"market":"binary"}),
            ),
            (
                "place_prediction_order",
                json!({"outcome":{"yes":{}},"side":{"ask":{}},"price":"200000","quantity":"5"}),
                json!({"market":"binary","order":"yes-order","owner":"alice"}),
            ),
            (
                "match_prediction_order",
                json!({"outcome":{"yes":{}},"takerSide":{"bid":{}},"quantity":"2"}),
                json!({"market":"binary","makerOrder":"yes-order","taker":"bob"}),
            ),
            (
                "cancel_prediction_order",
                json!({}),
                json!({"order":"yes-order"}),
            ),
        ];
        // Insert backwards: replay must honor block order, never arrival order.
        for (index, (name, args, accounts)) in rows.into_iter().enumerate().rev() {
            let signature = format!("signature-{index}");
            sqlx::query("INSERT INTO chain_transactions(signature,slot,transaction_index,block_time,raw_logs) VALUES($1,100,$2,120,'[]')").bind(&signature).bind(index as i32).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO transaction_execution VALUES($1,'{}')")
                .bind(&signature)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO instruction_decode_state(signature) VALUES($1)")
                .bind(&signature)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO decoded_instructions VALUES($1,0,$2,$3,$4)")
                .bind(&signature)
                .bind(name)
                .bind(Json(args))
                .bind(Json(accounts))
                .execute(&pool)
                .await
                .unwrap();
        }
        let client = Arc::new(RpcClient::new("http://127.0.0.1:1"));
        replay(&pool, Arc::clone(&client)).await.unwrap();
        replay(&pool, client).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM indexed_trades")
                .fetch_one(&pool)
                .await
                .unwrap(),
            3
        );
        let amounts:Vec<(String,String,String)>=sqlx::query_as("SELECT quantity::text,quote_atoms::text,fee_atoms::text FROM indexed_trades ORDER BY transaction_index").fetch_all(&pool).await.unwrap();
        assert_eq!(
            amounts,
            vec![
                ("3000000".into(), "1200000".into(), "3000".into()),
                ("6000000".into(), "2400000".into(), "6000".into()),
                ("2".into(), "400000".into(), "1000".into())
            ]
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT remaining::text FROM execution_orders WHERE address='yes-order'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "0"
        );
    }
}
