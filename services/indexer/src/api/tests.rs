use super::*;
use serde_json::Value;
#[cfg(test)]
mod account_queries {
    use super::*;
    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn graphql_reads_filters_and_unavailable_states(pool: PgPool) {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/ui-snapshot.json")).unwrap();
        let program = fixture["program"].as_str().unwrap();
        crate::account_store::bind_identity(&pool, "fixture-devnet", program)
            .await
            .unwrap();
        crate::account_store::apply(
            &pool,
            "confirmed",
            crate::account_store::parse_snapshot(fixture["snapshot"].clone(), program).unwrap(),
        )
        .await
        .unwrap();
        let (revisions, _) = broadcast::channel(4);
        let schema = Schema::build(Query::default(), EmptyMutation, Changes)
            .data(ApiState {
                pool: pool.clone(),
                revisions,
            })
            .limit_depth(8)
            .limit_complexity(2500)
            .finish();
        let response=schema.execute("{accounts(accountType:\"MultiOutcomeMarket\",first:1){nodes{address accountType data}sync{revision ready}hasNextPage}}").await;
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        let json = response.data.into_json().unwrap();
        assert_eq!(json["accounts"]["nodes"][0]["address"], fixture["market"]);
        assert_eq!(
            json["accounts"]["nodes"][0]["data"]["terms"]["outcomeLabels"],
            serde_json::json!(["Red", "Blue", "Green"])
        );
        let query=format!("{{accounts(accountType:\"MultiOutcomePosition\",filters:[{{offset:40,bytes:\"{}\"}}]){{nodes{{data}}}}}}",fixture["owner"].as_str().unwrap());
        let response = schema.execute(query).await;
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        assert_eq!(
            response.data.into_json().unwrap()["accounts"]["nodes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(!schema
            .execute("{accounts(accountType:\"AssetBalance\",first:501){nodes{address}}}")
            .await
            .errors
            .is_empty());
        sqlx::query("UPDATE account_sync SET ready=FALSE WHERE commitment='confirmed'")
            .execute(&pool)
            .await
            .unwrap();
        let response = schema
            .execute("{accounts(accountType:\"AssetBalance\"){nodes{address}}}")
            .await;
        assert!(!response.errors.is_empty());
    }
}

#[cfg(test)]
mod browser_fixture {
    use super::*;
    use crate::account_store;
    use base64::{engine::general_purpose::STANDARD, Engine};
    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires PostgreSQL, a built local frontend and Playwright; set INDEXER_BROWSER_TEST=1"]
    async fn browser_through_real_api_and_database(pool: PgPool) {
        if std::env::var("INDEXER_BROWSER_TEST").as_deref() != Ok("1") {
            return;
        }
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/ui-snapshot.json")).unwrap();
        account_store::bind_identity(&pool, "test-devnet", fixture["program"].as_str().unwrap())
            .await
            .unwrap();
        for level in ["confirmed", "finalized"] {
            account_store::apply(
                &pool,
                level,
                account_store::parse_snapshot(
                    fixture["snapshot"].clone(),
                    fixture["program"].as_str().unwrap(),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO mint_cache(address,owner,raw_base64,decimals) VALUES($1,$2,$3,6)")
            .bind(fixture["mint"].as_str().unwrap())
            .bind(fixture["mintInfo"]["owner"].as_str().unwrap())
            .bind(fixture["mintInfo"]["data"][0].as_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO backfill_checkpoints(program_id,completed) VALUES($1,TRUE)")
            .bind(fixture["program"].as_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO chain_transactions(signature,slot,transaction_index,raw_logs) VALUES('fixture-origin',1,0,'[]')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO transaction_execution VALUES('fixture-origin','{}')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO decoded_instructions(signature,execution_index,instruction_name,arguments,accounts) VALUES('fixture-origin',0,'initialize_protocol','{}','{}')").execute(&pool).await.unwrap();
        sqlx::query("UPDATE history_sync SET ready=TRUE,observed_at=NOW()")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO trade_projection_checkpoint(singleton) VALUES(TRUE)")
            .execute(&pool)
            .await
            .unwrap();
        for (i, price) in [(0, "400000"), (1, "600000")] {
            let signature = format!("fixture-trade-{i}");
            sqlx::query("INSERT INTO chain_transactions(signature,slot,transaction_index,block_time,raw_logs) VALUES($1,$2,$3,EXTRACT(EPOCH FROM NOW())::bigint-120+$3*60,'[]')").bind(&signature).bind(90_i64+i).bind(i as i32).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO indexed_trades SELECT $1,$1,slot,transaction_index,0,block_time,$2,'MULTI_OUTCOME','0','maker','taker','bid',$3::text::numeric,3,1200000,1000 FROM chain_transactions WHERE signature=$1")
                .bind(signature).bind(fixture["market"].as_str().unwrap()).bind(price).execute(&pool).await.unwrap();
        }
        let state = auth::state(pool.clone(), "http://127.0.0.1:3024").unwrap();
        let mut app = router(pool.clone(), state);
        let update_pool = pool.clone();
        let update_fixture = fixture.clone();
        app = app.route(
            "/fixture/update",
            post(move || {
                let pool = update_pool.clone();
                let fixture = update_fixture.clone();
                async move {
                    let mut snapshot = fixture["snapshot"].clone();
                    snapshot["context"]["slot"] = serde_json::json!(101);
                    for row in snapshot["value"].as_array_mut().unwrap() {
                        let mut bytes = STANDARD
                            .decode(row["account"]["data"][0].as_str().unwrap())
                            .unwrap();
                        if crate::account_data::decode_account(&bytes).unwrap().0 == "AssetBalance"
                        {
                            bytes[72..80].copy_from_slice(&77_000_000_u64.to_le_bytes());
                            row["account"]["data"][0] = serde_json::json!(STANDARD.encode(bytes));
                        }
                    }
                    account_store::apply(
                        &pool,
                        "confirmed",
                        account_store::parse_snapshot(
                            snapshot,
                            fixture["program"].as_str().unwrap(),
                        )
                        .unwrap(),
                    )
                    .await
                    .unwrap();
                    StatusCode::NO_CONTENT
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:8084")
            .await
            .unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let wallet_worker = tokio::spawn(crate::wallet_ingest::run(
            pool.clone(),
            std::sync::Arc::new(solana_rpc_client::rpc_client::RpcClient::new(
                "http://127.0.0.1:8085",
            )),
        ));
        let output = tokio::process::Command::new("node")
            .arg("scripts/indexer-browser.test.mjs")
            .current_dir("../../app")
            .env("INDEXER_BROWSER_BASE_URL", "http://127.0.0.1:3024")
            .output()
            .await
            .unwrap();
        server.abort();
        wallet_worker.abort();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_sessions")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        assert!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM wallet_assets")
                .fetch_one(&pool)
                .await
                .unwrap()
                > 0
        );
        eprintln!("{}", String::from_utf8_lossy(&output.stdout));
    }
}

#[cfg(test)]
mod receipt_tests {
    use super::*;
    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn receipt_requires_an_applied_snapshot_and_finalized_source(pool: PgPool) {
        let (revisions, _) = broadcast::channel(4);
        let schema = Schema::build(Query::default(), EmptyMutation, Changes)
            .data(ApiState {
                pool: pool.clone(),
                revisions,
            })
            .finish();
        let signature = bs58::encode([1_u8; 64]).into_string();
        sqlx::query("UPDATE account_sync SET slot=100,observed_at=NOW(),ready=TRUE")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO confirmed_receipts(signature,slot,failed) VALUES($1,101,FALSE)")
            .bind(&signature)
            .execute(&pool)
            .await
            .unwrap();
        let status = || async {
            let response = schema
                .execute(
                    async_graphql::Request::new("query($s:String!){transaction(signature:$s)}")
                        .variables(async_graphql::Variables::from_json(
                            serde_json::json!({"s":signature}),
                        )),
                )
                .await;
            assert!(response.errors.is_empty());
            response.data.into_json().unwrap()["transaction"]["status"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(status().await, "PENDING_INDEXING");
        sqlx::query("UPDATE account_sync SET slot=101 WHERE commitment='confirmed'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(status().await, "CONFIRMED_INDEXED");
        sqlx::query("UPDATE account_sync SET slot=101 WHERE commitment='finalized'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(status().await, "CONFIRMED_INDEXED");
        sqlx::query("INSERT INTO chain_transactions(signature,slot,transaction_index,raw_logs) VALUES($1,101,0,'[]')").bind(&signature).execute(&pool).await.unwrap();
        assert_eq!(status().await, "FINALIZED_INDEXED");
    }
}
