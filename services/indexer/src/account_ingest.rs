//! One shared, coalesced scan per commitment, independent of browser count.
use crate::{account_store, shutdown::wait_for_shutdown};
use futures_util::StreamExt;
use serde_json::{json, Value};
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use solana_pubsub_client::nonblocking::pubsub_client::PubsubClient;
use solana_rpc_client::rpc_client::RpcClient;
use solana_rpc_client_api::{
    config::{RpcAccountInfoConfig, RpcProgramAccountsConfig},
    request::RpcRequest,
};
use sqlx::PgPool;
use std::{
    error::Error,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
async fn scan(
    client: Arc<RpcClient>,
    pool: &PgPool,
    program: Pubkey,
    commitment: &str,
) -> Result<()> {
    let level = commitment.to_owned();
    let mint_client = Arc::clone(&client);
    let response:Value=tokio::task::spawn_blocking(move || client.send(RpcRequest::GetProgramAccounts,json!([program.to_string(),{"encoding":"base64","commitment":level,"withContext":true}]))).await??;
    let snapshot = account_store::parse_snapshot(response, &program.to_string())?;
    crate::mints::observe(pool, Arc::clone(&mint_client), &snapshot).await?;
    account_store::apply(pool, commitment, snapshot).await?;
    Ok(())
}
async fn watch(ws: String, program: Pubkey, dirty: Arc<AtomicBool>) {
    loop {
        let result = async {
            let client = PubsubClient::new(&ws).await?;
            let (mut stream, _unsubscribe) = client
                .program_subscribe(
                    &program,
                    Some(RpcProgramAccountsConfig {
                        account_config: RpcAccountInfoConfig {
                            encoding: Some(UiAccountEncoding::Base64),
                            commitment: Some(CommitmentConfig::confirmed()),
                            ..Default::default()
                        },
                        ..Default::default()
                    }),
                )
                .await?;
            dirty.store(true, Ordering::Release);
            while stream.next().await.is_some() {
                dirty.store(true, Ordering::Release);
            }
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("Account subscription reconnecting: {error}");
        }
        dirty.store(true, Ordering::Release);
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
pub async fn run(pool: PgPool, client: Arc<RpcClient>, program: Pubkey, ws: String) -> Result<()> {
    let rpc = Arc::clone(&client);
    let genesis = tokio::task::spawn_blocking(move || rpc.get_genesis_hash()).await??;
    // A provider for another cluster must not populate this devnet database.
    if genesis.to_string() != "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" {
        return Err("RPC is not Solana devnet".into());
    }
    account_store::bind_identity(&pool, &genesis.to_string(), &program.to_string()).await?;
    let dirty = Arc::new(AtomicBool::new(true));
    let subscription = tokio::spawn(watch(ws, program, Arc::clone(&dirty)));
    let mut timer = tokio::time::interval(Duration::from_secs(2));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ticks = 0_u64;
    loop {
        tokio::select! {
            _=wait_for_shutdown()=>{subscription.abort(); return Ok(());}
            _=timer.tick()=>{}
        }
        // Reconcile both views periodically even when the subscription is quiet
        // or has dropped notifications. Never run a scan in a GraphQL resolver.
        let reconcile = ticks.is_multiple_of(15);
        ticks = ticks.wrapping_add(1);
        if dirty.swap(false, Ordering::AcqRel) || reconcile {
            if let Err(error) = scan(Arc::clone(&client), &pool, program, "confirmed").await {
                account_store::failed(&pool, "confirmed", &error.to_string()).await;
                dirty.store(true, Ordering::Release);
                eprintln!("Confirmed account scan unavailable: {error}");
            }
        }
        if reconcile {
            if let Err(error) = scan(Arc::clone(&client), &pool, program, "finalized").await {
                account_store::failed(&pool, "finalized", &error.to_string()).await;
                eprintln!("Finalized account scan unavailable: {error}");
            }
        }
    }
}
