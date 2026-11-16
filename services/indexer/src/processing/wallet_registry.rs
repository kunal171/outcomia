//! Recover public user records from finalized sources without granting a session.
use sqlx::{PgPool, Row};

pub async fn discover(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    // Account tombstones retain owners for exited markets. Instruction history
    // also recovers a wallet whose deposit/balance account has already closed.
    let rows = sqlx::query(
        r#"
        WITH sources AS (
            SELECT data->>'owner' AS owner, slot
            FROM indexed_accounts
            WHERE commitment='finalized'
              AND account_type IN ('AssetBalance','TraderBalance','PredictionPosition','MultiOutcomePosition')
            UNION ALL
            SELECT i.accounts->>'owner', t.slot
            FROM decoded_instructions i JOIN chain_transactions t USING(signature)
            WHERE i.instruction_name IN ('deposit','deposit_asset','deposit_prediction_collateral',
                'initialize_asset_balance','initialize_trader_balance','initialize_prediction_position')
        ), candidates AS (
            SELECT owner, MIN(slot) AS slot FROM sources
            WHERE owner ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
              AND NOT EXISTS(SELECT 1 FROM users u WHERE u.wallet_address=sources.owner)
            GROUP BY owner ORDER BY MIN(slot),owner LIMIT 200
        )
        INSERT INTO users(wallet_address,registration_source,first_observed_slot)
        SELECT owner,'chain',slot FROM candidates
        ON CONFLICT(wallet_address) DO NOTHING
        RETURNING wallet_address
        "#,
    ).fetch_all(&mut *tx).await?;
    for row in &rows {
        sqlx::query("INSERT INTO tracked_wallets(owner) VALUES($1) ON CONFLICT DO NOTHING")
            .bind(row.get::<String, _>("wallet_address"))
            .execute(&mut *tx)
            .await?;
    }
    let mut inserted = rows.len() as u64;
    let events = sqlx::query(
        r#"
        SELECT e.signature,e.log_index,t.slot,
            CASE e.event_type
                WHEN 'DepositEvent' THEN e.decoded_event #> '{Balance,Deposited,owner}'
                WHEN 'TraderBalanceInitializedEvent' THEN e.decoded_event #> '{Balance,Initialized,owner}'
            END AS owner
        FROM chain_events e JOIN chain_transactions t USING(signature)
        WHERE e.event_type IN ('DepositEvent','TraderBalanceInitializedEvent')
          AND NOT EXISTS(SELECT 1 FROM wallet_registration_events r
              WHERE r.signature=e.signature AND r.log_index=e.log_index)
        ORDER BY t.slot,e.signature,e.log_index LIMIT 200
        "#,
    ).fetch_all(&mut *tx).await?;
    for event in events {
        let value: serde_json::Value = event.get("owner");
        let owner: solana_pubkey::Pubkey = if let Some(text) = value.as_str() {
            text.parse()
                .map_err(|error| sqlx::Error::Decode(Box::new(error)))?
        } else {
            serde_json::from_value(value).map_err(|error| sqlx::Error::Decode(Box::new(error)))?
        };
        let result = sqlx::query("INSERT INTO users(wallet_address,registration_source,first_observed_slot) VALUES($1,'chain',$2) ON CONFLICT(wallet_address) DO NOTHING")
            .bind(owner.to_string()).bind(event.get::<i64,_>("slot")).execute(&mut *tx).await?;
        if result.rows_affected() > 0 {
            inserted += 1;
            sqlx::query("INSERT INTO tracked_wallets(owner) VALUES($1) ON CONFLICT DO NOTHING")
                .bind(owner.to_string())
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("INSERT INTO wallet_registration_events(signature,log_index) VALUES($1,$2) ON CONFLICT DO NOTHING")
            .bind(event.get::<String,_>("signature")).bind(event.get::<i32,_>("log_index")).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Row;

    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn finalized_wallets_and_backfilled_deposits_register_once_without_signing_in(
        pool: PgPool,
    ) {
        let owner = bs58::encode([7_u8; 32]).into_string();
        let other = bs58::encode([8_u8; 32]).into_string();
        sqlx::query("INSERT INTO indexed_accounts(commitment,address,account_type,data,raw_base64,lamports,slot,revision,deleted) VALUES('confirmed','balance','AssetBalance',jsonb_build_object('owner',$1::text),'AA==',1,100,1,FALSE)")
            .bind(&owner).execute(&pool).await.unwrap();
        assert_eq!(discover(&pool).await.unwrap(), 0);
        sqlx::query("UPDATE indexed_accounts SET commitment='finalized'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(discover(&pool).await.unwrap(), 1);
        assert_eq!(discover(&pool).await.unwrap(), 0);
        let row=sqlx::query("SELECT id::text,registration_source,last_login_at IS NULL AS never_signed_in,verified_at IS NULL AS unverified,first_observed_slot FROM users WHERE wallet_address=$1")
            .bind(&owner).fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<String, _>("registration_source"), "chain");
        assert!(row.get::<bool, _>("never_signed_in"));
        assert!(row.get::<bool, _>("unverified"));
        assert_eq!(row.get::<i64, _>("first_observed_slot"), 100);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_sessions")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM tracked_wallets")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );

        sqlx::query("INSERT INTO chain_transactions(signature,slot,transaction_index,raw_logs) VALUES('backfilled-deposit',80,0,'[]')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO transaction_execution VALUES('backfilled-deposit','{}')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO decoded_instructions(signature,execution_index,instruction_name,arguments,accounts) VALUES('backfilled-deposit',0,'deposit_asset','{}',jsonb_build_object('owner',$1::text))")
            .bind(&other).execute(&pool).await.unwrap();
        assert_eq!(discover(&pool).await.unwrap(), 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT first_observed_slot FROM users WHERE wallet_address=$1"
            )
            .bind(other)
            .fetch_one(&pool)
            .await
            .unwrap(),
            80
        );
        assert_eq!(discover(&pool).await.unwrap(), 0);

        // Retained legacy events also work when the full instruction body is unavailable.
        let legacy_owner = solana_pubkey::Pubkey::new_from_array([9; 32]);
        let key = solana_pubkey::Pubkey::new_from_array([1; 32]);
        let event = crate::decoder::OutcomiaEvent::Balance(
            crate::decoder::BalanceEvent::Deposited(crate::decoder::types::DepositEvent {
                market: key,
                owner: legacy_owner,
                trader_balance: key,
                mint: key,
                market_vault: key,
                amount: 1,
                free_balance: 1,
            }),
        );
        sqlx::query("INSERT INTO chain_transactions(signature,slot,transaction_index,raw_logs) VALUES('legacy-deposit',70,0,'[]')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chain_events(signature,log_index,event_type,payload_base64,decoded_event) VALUES('legacy-deposit',0,'DepositEvent','AA==',$1)")
            .bind(sqlx::types::Json(event)).execute(&pool).await.unwrap();
        assert_eq!(discover(&pool).await.unwrap(), 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT first_observed_slot FROM users WHERE wallet_address=$1"
            )
            .bind(legacy_owner.to_string())
            .fetch_one(&pool)
            .await
            .unwrap(),
            70
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM user_sessions")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }
}
