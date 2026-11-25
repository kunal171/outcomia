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
        let schema = Schema::build(Query::default(), Mutation::default(), Changes)
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
        let wallet_pool = pool.clone();
        let wallet_worker = tokio::spawn(async move {
            // The Node child owns the local RPC fixture; discovery now starts
            // tracking wallets before login, so wait for its listener first.
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if tokio::net::TcpStream::connect("127.0.0.1:8085")
                        .await
                        .is_ok()
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .expect("local RPC fixture must start");
            crate::wallet_ingest::run(
                wallet_pool,
                std::sync::Arc::new(solana_rpc_client::rpc_client::RpcClient::new(
                    "http://127.0.0.1:8085",
                )),
            )
            .await;
        });
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
        let schema = Schema::build(Query::default(), Mutation::default(), Changes)
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

#[test]
fn database_failures_are_unavailable_but_invalid_queries_remain_visible() {
    let error = async_graphql::Error::from(sqlx::Error::PoolClosed)
        .into_server_error(async_graphql::Pos::default());
    let (status, Json(response)) =
        graphql_response(async_graphql::Response::from_errors(vec![error]));
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        response.errors[0].message,
        "Indexed data service is unavailable"
    );
    let (status, _) = graphql_response(async_graphql::Response::from_errors(vec![
        async_graphql::ServerError::new("Invalid account filter", None),
    ]));
    assert_eq!(status, StatusCode::OK);
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires isolated PostgreSQL"]
async fn known_chain_wallet_reads_resume_tracking_without_a_session(pool: PgPool) {
    let owner = bs58::encode([6_u8; 32]).into_string();
    sqlx::query("INSERT INTO users(wallet_address,registration_source,first_observed_slot) VALUES($1,'chain',10)")
        .bind(&owner).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO tracked_wallets(owner,requested_at) VALUES($1,NOW()-INTERVAL '40 minutes')",
    )
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    let (revisions, _) = broadcast::channel(4);
    let schema = Schema::build(Query::default(), Mutation::default(), Changes)
        .data(ApiState {
            pool: pool.clone(),
            revisions,
        })
        .finish();
    let response = schema
        .execute(format!("{{walletAssets(owner:\"{owner}\")}} "))
        .await;
    assert!(
        !response.errors.is_empty(),
        "holdings stay warming until the shared worker refreshes them"
    );
    assert!(sqlx::query_scalar::<_, bool>(
        "SELECT requested_at>NOW()-INTERVAL '1 minute' FROM tracked_wallets WHERE owner=$1"
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap());
    assert!(sqlx::query_scalar::<_, bool>(
        "SELECT verified_at IS NULL AND last_login_at IS NULL FROM users WHERE wallet_address=$1"
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_sessions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
}

#[cfg(test)]
mod profiles_and_leaderboards {
    use super::*;
    use crate::auth::User;

    fn key(byte: u8) -> String {
        bs58::encode([byte; 32]).into_string()
    }

    fn schema(pool: &PgPool) -> AppSchema {
        let (revisions, _) = broadcast::channel(4);
        Schema::build(Query::default(), Mutation::default(), Changes)
            .data(ApiState {
                pool: pool.clone(),
                revisions,
            })
            .finish()
    }

    async fn run(schema: &AppSchema, query: String) -> Value {
        let response = schema.execute(query).await;
        assert!(response.errors.is_empty(), "{:?}", response.errors);
        response.data.into_json().unwrap()
    }

    async fn sql(pool: &PgPool, statement: &str) {
        sqlx::query(sqlx::AssertSqlSafe(statement.to_owned()))
            .execute(pool)
            .await
            .unwrap();
    }

    /// Binary market M (payout 100, resolved YES) and multi-outcome market N
    /// (3 outcomes, payout 90, resolved invalid so each outcome pays 30).
    /// Expected binary results, worked by hand:
    ///   A: bought 10 YES @30 (+fee 3) and 5 YES @40 as a complement maker:
    ///      -300-3-200 + 15*100 = +997
    ///   B: split 10 sets (-1000), sold 10 YES @30 (+300), keeps 10 NO: -700
    ///   C: bought 5 NO @60 as complement taker (+fee 3): -303
    /// The market nets to minus the 6 atoms of fees.
    async fn seed(pool: &PgPool) {
        let (mint, market, multi) = (key(9), key(10), key(11));
        let (a, b, c, d, e, f) = (key(1), key(2), key(3), key(4), key(5), key(6));
        sql(pool, &format!(
            "INSERT INTO indexed_accounts(commitment,address,account_type,data,raw_base64,lamports,slot,revision) VALUES
             ('confirmed','{market}','PredictionMarket','{{\"collateralMint\":\"{mint}\",\"payoutPerContract\":\"100\",\"status\":{{\"resolved\":{{}}}},\"finalOutcome\":{{\"yes\":{{}}}},\"authority\":\"{d}\"}}','',0,5,1),
             ('confirmed','{multi}','MultiOutcomeMarket','{{\"collateralMint\":\"{mint}\",\"terms\":{{\"payoutPerContract\":\"90\",\"outcomeLabels\":[\"Red\",\"Blue\",\"Green\"]}},\"status\":{{\"resolved\":{{}}}},\"finalOutcome\":{{\"invalid\":{{}}}},\"authority\":\"{d}\"}}','',0,5,1),
             ('confirmed','{key}','MarketMetadata','{{\"market\":\"{market}\",\"displayName\":\"Will it rain?\"}}','',0,5,1)",
            key = key(12),
        )).await;
        for (signature, slot) in [("s1", 1), ("s2", 2), ("s3", 3), ("s4", 4), ("s5", 5)] {
            sql(pool, &format!(
                "INSERT INTO chain_transactions(signature,slot,transaction_index,block_time,raw_logs) VALUES('{signature}',{slot},0,EXTRACT(EPOCH FROM NOW())::bigint,'[]')"
            )).await;
        }
        sql(
            pool,
            "INSERT INTO transaction_execution(signature,body) VALUES('s1','{}'),('s4','{}')",
        )
        .await;
        sql(pool, &format!(
            "INSERT INTO decoded_instructions(signature,execution_index,instruction_name,arguments,accounts) VALUES
             ('s1',0,'shared_complete_set','{{\"split\":true,\"quantity\":\"10\"}}','{{\"owner\":\"{b}\",\"market\":\"{market}\"}}'),
             ('s4',0,'multi_outcome_complete_set','{{\"split\":true,\"quantity\":\"2\"}}','{{\"owner\":\"{d}\",\"market\":\"{multi}\"}}')"
        )).await;
        let set = "11111111111111111111111111111111";
        sql(pool, &format!(
            "INSERT INTO indexed_trades(execution_id,signature,slot,transaction_index,execution_index,block_time,market,engine,outcome,maker,taker,taker_side,price,quantity,quote_atoms,fee_atoms) VALUES
             ('s2:ix:0','s2',2,0,0,EXTRACT(EPOCH FROM NOW())::bigint,'{market}','SHARED_BINARY','0','{b}','{a}','bid',30,10,300,3),
             ('s3:ix:0','s3',3,0,0,EXTRACT(EPOCH FROM NOW())::bigint,'{market}','SHARED_BINARY','1','{a}','{c}','bid',60,5,300,3),
             ('s3:ix:0:maker','s3',3,0,0,EXTRACT(EPOCH FROM NOW())::bigint,'{market}','SHARED_BINARY','0','{a}','{c}','bid',40,5,200,0),
             ('s5:1','s5',5,0,1,EXTRACT(EPOCH FROM NOW())::bigint,'{multi}','MULTI_OUTCOME','1','{e}','{f}','bid',20,1,20,0),
             ('s5:2','s5',5,0,2,EXTRACT(EPOCH FROM NOW())::bigint,'{multi}','MULTI_OUTCOME','0','{set}','{f}','bid',50,1,50,1)"
        )).await;
    }

    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn positions_profit_and_rankings_follow_every_leg(pool: PgPool) {
        seed(&pool).await;
        let (mint, market, multi) = (key(9), key(10), key(11));
        let (a, b, c, d, e, f) = (key(1), key(2), key(3), key(4), key(5), key(6));
        let profit = |wallet: &str, market: &str| {
            let (pool, wallet, market) = (pool.clone(), wallet.to_owned(), market.to_owned());
            async move {
                sqlx::query_scalar::<_, String>(
                    "SELECT profit::text FROM resolved_market_results WHERE wallet=$1 AND market=$2",
                )
                .bind(wallet)
                .bind(market)
                .fetch_one(&pool)
                .await
                .unwrap()
            }
        };
        assert_eq!(profit(&a, &market).await, "997");
        assert_eq!(profit(&b, &market).await, "-700");
        assert_eq!(profit(&c, &market).await, "-303");
        // Invalid pays 30 per outcome: the split sets are worth their cost,
        // the complement maker leg is a purchase, the taker paid its fee.
        assert_eq!(profit(&d, &multi).await, "0");
        assert_eq!(profit(&e, &multi).await, "10");
        assert_eq!(profit(&f, &multi).await, "-21");
        let total: String = sqlx::query_scalar(
            "SELECT SUM(profit)::text FROM resolved_market_results WHERE market=$1",
        )
        .bind(&market)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(total, "-6", "a market nets to minus its fees");

        let schema = schema(&pool);
        let volume = run(&schema, format!("{{traderLeaderboard(board:VOLUME,period:DAY,mint:\"{mint}\"){{rank wallet volume trades}}}}")).await;
        let rows = volume["traderLeaderboard"].as_array().unwrap();
        assert_eq!(rows[0]["wallet"], a.as_str());
        assert_eq!(rows[0]["volume"], "500");
        assert_eq!(rows[0]["trades"], 2);
        let makers = run(&schema, format!("{{traderLeaderboard(board:MAKERS,period:ALL,mint:\"{mint}\"){{wallet makerVolume}}}}")).await;
        let makers: Vec<&str> = makers["traderLeaderboard"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["wallet"].as_str().unwrap())
            .collect();
        assert_eq!(makers[..2], [b.as_str(), a.as_str()]);
        let top = run(&schema, format!("{{traderLeaderboard(board:PROFIT,period:ALL,mint:\"{mint}\"){{wallet profit wins losses}}}}")).await;
        assert_eq!(top["traderLeaderboard"][0]["wallet"], a.as_str());
        assert_eq!(top["traderLeaderboard"][0]["profit"], "997");
        let accuracy = run(
            &schema,
            format!("{{traderLeaderboard(board:ACCURACY,period:ALL,mint:\"{mint}\",minMarkets:1){{wallet wins losses}}}}"),
        )
        .await;
        let accuracy = accuracy["traderLeaderboard"].as_array().unwrap();
        // A and E both won their only decided market; losers rank after them.
        assert_eq!(accuracy[0]["losses"], 0);
        assert!(accuracy[..2].iter().any(|r| r["wallet"] == a.as_str()));
        assert_eq!(accuracy.last().unwrap()["wins"], 0);
        let calls = run(
            &schema,
            format!(
                "{{bestCalls(mint:\"{mint}\"){{wallet price multiple profit outcomeLabel title}}}}"
            ),
        )
        .await;
        assert_eq!(calls["bestCalls"][0]["price"], "30");
        assert_eq!(calls["bestCalls"][0]["multiple"], "3.33");
        assert_eq!(calls["bestCalls"][0]["profit"], "700");
        assert_eq!(calls["bestCalls"][0]["title"], "Will it rain?");
        assert_eq!(
            calls["bestCalls"].as_array().unwrap().len(),
            2,
            "invalid markets have no winning calls"
        );
        let traders = run(&schema, format!("{{marketTraders(market:\"{market}\"){{wallet profit holdings{{label contracts}}}}}}")).await;
        let b_row = traders["marketTraders"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["wallet"] == b.as_str())
            .unwrap();
        assert_eq!(
            b_row["holdings"],
            serde_json::json!([{"label":"No","contracts":"10"}])
        );
        let stats = run(&schema, format!("{{traderStats(wallet:\"{a}\"){{perMint{{mint volume profit wins}} settled{{title profit}} recentTrades{{role contracts}}}}}}")).await;
        assert_eq!(stats["traderStats"]["perMint"][0]["profit"], "997");
        assert_eq!(stats["traderStats"]["settled"][0]["title"], "Will it rain?");

        // Opting out removes a wallet from every public ranking.
        sql(
            &pool,
            &format!("INSERT INTO users(wallet_address,verified_at) VALUES('{b}',NOW())"),
        )
        .await;
        sql(&pool, &format!("INSERT INTO profiles(wallet,username,show_on_leaderboards) VALUES('{b}','bee',FALSE)")).await;
        let volume = run(
            &schema,
            format!("{{traderLeaderboard(board:VOLUME,period:ALL,mint:\"{mint}\"){{wallet}}}}"),
        )
        .await;
        assert!(volume["traderLeaderboard"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["wallet"] != b.as_str()));
        let _ = d;
    }

    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn only_the_signed_in_wallet_edits_its_profile_from_the_app(pool: PgPool) {
        let (alice, bob) = (key(1), key(2));
        for wallet in [&alice, &bob] {
            sql(
                &pool,
                &format!("INSERT INTO users(wallet_address,verified_at) VALUES('{wallet}',NOW())"),
            )
            .await;
        }
        let schema = schema(&pool);
        let edit = |username: &str| {
            format!(
            "mutation{{updateProfile(input:{{username:\"{username}\",displayName:\"Alice\",bio:\"hi\",avatarHue:12,xHandle:\"@alice\",showOnLeaderboards:true}}){{wallet username xHandle}}}}"
        )
        };
        let user = |wallet: &str| {
            Some(User {
                id: "id".into(),
                wallet: wallet.into(),
            })
        };

        let anonymous = schema
            .execute(
                async_graphql::Request::new(edit("alice"))
                    .data(None::<User>)
                    .data(SameOrigin(true)),
            )
            .await;
        assert!(!anonymous.errors.is_empty());
        let cross_site = schema
            .execute(
                async_graphql::Request::new(edit("alice"))
                    .data(user(&alice))
                    .data(SameOrigin(false)),
            )
            .await;
        assert!(
            !cross_site.errors.is_empty(),
            "another origin must not edit with the cookie"
        );

        let saved = schema
            .execute(
                async_graphql::Request::new(edit("Alice"))
                    .data(user(&alice))
                    .data(SameOrigin(true)),
            )
            .await;
        assert!(saved.errors.is_empty(), "{:?}", saved.errors);
        let saved = saved.data.into_json().unwrap();
        assert_eq!(saved["updateProfile"]["wallet"], alice.as_str());
        assert_eq!(saved["updateProfile"]["username"], "alice");
        assert_eq!(saved["updateProfile"]["xHandle"], "alice");

        let taken = schema
            .execute(
                async_graphql::Request::new(edit("alice"))
                    .data(user(&bob))
                    .data(SameOrigin(true)),
            )
            .await;
        assert_eq!(taken.errors[0].message, "That username is taken");

        let found = run(
            &schema,
            "{profile(username:\"ALICE\"){wallet displayName}}".into(),
        )
        .await;
        assert_eq!(found["profile"]["wallet"], alice.as_str());
        let many = run(
            &schema,
            format!("{{profiles(wallets:[\"{alice}\",\"{bob}\"]){{username}}}}"),
        )
        .await;
        assert_eq!(many["profiles"].as_array().unwrap().len(), 1);
    }
}
