//! Exact finalized executions back all chart styles; book snapshots never invent trades.
use crate::{
    decoder::{decode_event, MultiOutcomeEvent, OutcomiaEvent},
    events::RawEventLog,
};
use async_graphql::SimpleObject;
use sqlx::{PgPool, Row};
use std::{error::Error, time::Duration};
type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
#[derive(SimpleObject)]
pub struct Candle {
    pub time: String,
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
    pub quantity: String,
    pub quote_volume: String,
    pub trades: i32,
}
#[derive(SimpleObject)]
pub struct CandleSeries {
    pub supported: bool,
    pub coverage: String,
    pub commitment: String,
    pub error: Option<String>,
    pub candles: Vec<Candle>,
}
pub async fn query(
    pool: &PgPool,
    market: &str,
    engine: &str,
    outcome: &str,
    interval: i32,
    from: &str,
    to: &str,
) -> async_graphql::Result<CandleSeries> {
    if market.len() > 64
        || outcome.len() > 16
        || ![60, 300, 900, 3600, 14400, 86400].contains(&interval)
    {
        return Err("Invalid chart filters or interval".into());
    }
    let from = from
        .parse::<i64>()
        .map_err(|_| async_graphql::Error::new("Invalid chart start"))?;
    let to = to
        .parse::<i64>()
        .map_err(|_| async_graphql::Error::new("Invalid chart end"))?;
    if from < 0
        || to <= from
        || to > 253402300799
        || (to - 1) / i64::from(interval) - from / i64::from(interval) + 1 > 2000
    {
        return Err("Chart range exceeds 2000 intervals".into());
    }
    if !matches!(
        engine,
        "LEGACY_SPOT" | "LEGACY_BINARY" | "SHARED_SPOT" | "SHARED_BINARY" | "MULTI_OUTCOME"
    ) {
        return Ok(CandleSeries {
            supported: false,
            coverage: "UNSUPPORTED".into(),
            commitment: "finalized".into(),
            error: Some("Execution ingestion is not available for this book engine".into()),
            candles: vec![],
        });
    }
    // Instruction-replay engines: replay is program-wide, so on a busy program a
    // few transactions are almost always still being decoded or replayed. Keep
    // serving the trades already indexed and mark the series PARTIAL until
    // replay catches up, instead of blanking every chart.
    let mut catching_up = false;
    if matches!(engine, "LEGACY_BINARY" | "SHARED_SPOT" | "SHARED_BINARY") {
        let replayed: bool = sqlx::query_scalar(
            "SELECT ready AND last_error IS NULL AND NOT EXISTS(SELECT 1 FROM decoded_instructions WHERE NOT replayed) AND NOT EXISTS(SELECT 1 FROM chain_transactions t LEFT JOIN instruction_decode_state d USING(signature) WHERE d.signature IS NULL OR t.transaction_index IS NULL) FROM execution_replay_state WHERE singleton",
        )
        .fetch_one(pool)
        .await?;
        catching_up = !replayed;
    }
    let ordered:bool=sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM indexed_trades WHERE market=$1 AND engine=$2 AND outcome=$3 AND (block_time IS NULL OR transaction_index IS NULL))").bind(market).bind(engine).bind(outcome).fetch_one(pool).await?;
    // A trade projected a moment before its block time is known is left out
    // of the buckets (block_time IS NULL never matches) and marks the series
    // PARTIAL until enrichment fills it in, instead of blanking the chart.
    catching_up |= !ordered;
    let complete:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM history_sync WHERE ready AND observed_at>NOW()-INTERVAL '90 seconds') AND (EXISTS(SELECT 1 FROM chain_events WHERE event_type='ProtocolInitializedEvent') OR EXISTS(SELECT 1 FROM decoded_instructions WHERE instruction_name='initialize_protocol')) AND EXISTS(SELECT 1 FROM backfill_checkpoints WHERE completed) AND EXISTS(SELECT 1 FROM trade_projection_checkpoint WHERE last_error IS NULL AND updated_at>NOW()-INTERVAL '90 seconds') AND NOT EXISTS(SELECT 1 FROM chain_events e WHERE event_type IN ('FillEvent','MultiOutcomeFillEvent') AND NOT EXISTS(SELECT 1 FROM indexed_trades t WHERE t.execution_id=e.signature||':'||e.log_index::text))").fetch_one(pool).await?;
    let rows=sqlx::query("SELECT (block_time/$4::bigint)*$4::bigint AS bucket,(array_agg(price ORDER BY slot,transaction_index,execution_index))[1]::text AS open,MAX(price)::text AS high,MIN(price)::text AS low,(array_agg(price ORDER BY slot DESC,transaction_index DESC,execution_index DESC))[1]::text AS close,SUM(quantity)::text AS quantity,SUM(quote_atoms)::text AS volume,COUNT(*) AS trades FROM indexed_trades WHERE market=$1 AND engine=$2 AND outcome=$3 AND block_time>=$5 AND block_time<$6 GROUP BY bucket ORDER BY bucket LIMIT 2000")
        .bind(market).bind(engine).bind(outcome).bind(interval).bind(from).bind(to).fetch_all(pool).await?;
    let candles = rows
        .into_iter()
        .map(|r| {
            Ok(Candle {
                time: r.get::<i64, _>("bucket").to_string(),
                open: r.get("open"),
                high: r.get("high"),
                low: r.get("low"),
                close: r.get("close"),
                quantity: r.get("quantity"),
                quote_volume: r.get("volume"),
                trades: i32::try_from(r.get::<i64, _>("trades"))?,
            })
        })
        .collect::<std::result::Result<Vec<_>, std::num::TryFromIntError>>()?;
    Ok(CandleSeries {
        supported: true,
        coverage: if complete && !catching_up {
            "COMPLETE"
        } else {
            "PARTIAL"
        }
        .into(),
        commitment: "finalized".into(),
        error: None,
        candles,
    })
}
pub async fn project(pool: &PgPool) -> Result<usize> {
    // Previously stored events can gain a canonical position during enrichment.
    sqlx::query(
        "UPDATE indexed_trades p SET transaction_index=COALESCE(p.transaction_index,t.transaction_index), block_time=COALESCE(p.block_time,t.block_time) FROM chain_transactions t WHERE p.signature=t.signature AND ((p.transaction_index IS NULL AND t.transaction_index IS NOT NULL) OR (p.block_time IS NULL AND t.block_time IS NOT NULL))",
    ).execute(pool).await?;
    let rows=sqlx::query("SELECT e.signature,e.log_index,e.payload_base64,t.slot,t.transaction_index,t.block_time FROM chain_events e JOIN chain_transactions t USING(signature) WHERE e.event_type IN ('FillEvent','MultiOutcomeFillEvent') AND NOT EXISTS(SELECT 1 FROM indexed_trades p WHERE p.execution_id=e.signature||':'||e.log_index::text) ORDER BY t.slot,t.transaction_index NULLS LAST,e.log_index LIMIT 500").fetch_all(pool).await?;
    let count = rows.len();
    let mut tx = pool.begin().await?;
    for row in rows {
        let index: i32 = row.get("log_index");
        let signature: String = row.get("signature");
        let event = decode_event(&RawEventLog {
            log_index: index as usize,
            payload_base64: row.get("payload_base64"),
        })?
        .event;
        let (market, engine, outcome, maker, taker, side, price, quantity, quote, fee) = match event
        {
            OutcomiaEvent::Fill(f) => (
                f.market,
                "LEGACY_SPOT",
                "spot".to_owned(),
                f.maker,
                f.taker,
                match f.maker_side {
                    crate::decoder::types::OrderSide::Bid => "ask",
                    crate::decoder::types::OrderSide::Ask => "bid",
                },
                f.execution_price,
                f.base_quantity,
                f.quote_quantity,
                f.taker_fee_quote,
            ),
            OutcomiaEvent::MultiOutcome(MultiOutcomeEvent::Fill(f)) => (
                f.market,
                "MULTI_OUTCOME",
                f.outcome.to_string(),
                f.maker,
                f.taker,
                match f.taker_side {
                    crate::decoder::types::OrderSide::Bid => "bid",
                    crate::decoder::types::OrderSide::Ask => "ask",
                },
                f.price,
                f.quantity,
                f.collateral_atoms,
                f.fee_atoms,
            ),
            _ => return Err("Unexpected execution event".into()),
        };
        sqlx::query("INSERT INTO indexed_trades(execution_id,signature,slot,transaction_index,execution_index,block_time,market,engine,outcome,maker,taker,taker_side,price,quantity,quote_atoms,fee_atoms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text::numeric,$14::text::numeric,$15::text::numeric,$16::text::numeric) ON CONFLICT DO NOTHING")
            .bind(format!("{signature}:{index}")).bind(signature).bind(row.get::<i64,_>("slot")).bind(row.get::<Option<i32>,_>("transaction_index")).bind(index).bind(row.get::<Option<i64>,_>("block_time"))
            .bind(market.to_string()).bind(engine).bind(outcome).bind(maker.to_string()).bind(taker.to_string()).bind(side).bind(price.to_string()).bind(quantity.to_string()).bind(quote.to_string()).bind(fee.to_string()).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO trade_projection_checkpoint(singleton) VALUES(TRUE) ON CONFLICT(singleton) DO UPDATE SET updated_at=NOW(),last_error=NULL").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(count)
}
pub async fn run(pool: PgPool) {
    loop {
        match project(&pool).await {
            Ok(500) => continue,
            Ok(_) => {}
            Err(error) => {
                eprintln!("Trade projection unavailable: {error}");
                let _=sqlx::query("INSERT INTO trade_projection_checkpoint(singleton,last_error) VALUES(TRUE,$1) ON CONFLICT(singleton) DO UPDATE SET last_error=EXCLUDED.last_error").bind(error.to_string()).execute(&pool).await;
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[sqlx::test(migrations = "./migrations")]
    #[ignore = "requires isolated PostgreSQL"]
    async fn chart_order_and_volume_are_exact(pool: PgPool) {
        for (signature, index, price) in [
            ("later", 2, "9007199254740999"),
            ("earlier", 1, "9007199254740993"),
        ] {
            sqlx::query("INSERT INTO chain_transactions(signature,slot,transaction_index,raw_logs) VALUES($1,50,$2,'[]')").bind(signature).bind(index).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO indexed_trades VALUES($1,$1,50,$2,0,120,'market','LEGACY_SPOT','spot','maker','taker','bid',$3::text::numeric,3,10,1)").bind(signature).bind(index).bind(price).execute(&pool).await.unwrap();
        }
        let series = query(&pool, "market", "LEGACY_SPOT", "spot", 60, "0", "240")
            .await
            .unwrap();
        assert_eq!(series.candles.len(), 1);
        let candle = &series.candles[0];
        assert_eq!(candle.open, "9007199254740993");
        assert_eq!(candle.close, "9007199254740999");
        assert_eq!(candle.quantity, "6");
        assert_eq!(candle.quote_volume, "20");
        assert!(
            !query(&pool, "market", "UNKNOWN", "spot", 60, "0", "240")
                .await
                .unwrap()
                .supported
        );
        assert!(
            query(&pool, "market", "LEGACY_SPOT", "spot", 60, "0", "999999999")
                .await
                .is_err()
        );

        // An unaligned range intersects 2001 buckets even though its duration is 2000 intervals.
        assert!(
            query(&pool, "market", "LEGACY_SPOT", "spot", 60, "1", "120001")
                .await
                .is_err()
        );
        assert!(
            query(&pool, "market", "LEGACY_SPOT", "spot", 60, "60", "120060")
                .await
                .is_ok()
        );
        sqlx::query("UPDATE indexed_trades SET transaction_index=NULL WHERE signature='earlier'")
            .execute(&pool)
            .await
            .unwrap();
        // A trade whose chain order is not known yet keeps the chart served
        // and marks it PARTIAL until enrichment fills the order in.
        let pending = query(&pool, "market", "LEGACY_SPOT", "spot", 60, "0", "240")
            .await
            .unwrap();
        assert_eq!(pending.coverage, "PARTIAL");
        assert_eq!(pending.candles.len(), 1);
        project(&pool).await.unwrap();
        assert_eq!(
            query(&pool, "market", "LEGACY_SPOT", "spot", 60, "0", "240")
                .await
                .unwrap()
                .candles[0]
                .open,
            "9007199254740993"
        );
        sqlx::query("INSERT INTO transaction_execution VALUES('earlier','{}')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO decoded_instructions(signature,execution_index,instruction_name,arguments,accounts) VALUES('earlier',0,'initialize_protocol','{}','{}')")
            .execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO backfill_checkpoints(program_id,completed) VALUES('program',TRUE)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE history_sync SET ready=TRUE,observed_at=NOW()")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            query(&pool, "market", "LEGACY_SPOT", "spot", 60, "0", "240")
                .await
                .unwrap()
                .coverage,
            "COMPLETE"
        );
        sqlx::query("UPDATE history_sync SET ready=FALSE")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            query(&pool, "market", "LEGACY_SPOT", "spot", 60, "0", "240")
                .await
                .unwrap()
                .coverage,
            "PARTIAL"
        );
    }
}
