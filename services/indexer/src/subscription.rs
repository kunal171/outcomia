use std::{error::Error, future::Future, io};

use futures_util::StreamExt;
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use solana_pubsub_client::nonblocking::pubsub_client::PubsubClient;
use solana_rpc_client_api::config::{
    RpcTransactionLogsConfig,
    RpcTransactionLogsFilter,
};
use solana_signature::Signature;

type BoxError = Box<dyn Error + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogWakeup {
    pub signature: Signature,
    pub slot: u64,
}

pub async fn run_log_subscription<OnWakeup, WakeupFuture>(
    websocket_url: &str,
    program_id: &Pubkey,
    mut on_wakeup: OnWakeup,
) -> Result<(), BoxError>
where
    OnWakeup: FnMut(LogWakeup) -> WakeupFuture,
    WakeupFuture: Future<Output = Result<(), BoxError>>,
{
    let client = PubsubClient::new(websocket_url).await?;

    let (mut notifications, unsubscribe) = client
        .logs_subscribe(
            RpcTransactionLogsFilter::Mentions(vec![
                program_id.to_string(),
            ]),
            RpcTransactionLogsConfig {
                commitment: Some(
                    CommitmentConfig::finalized(),
                ),
            },
        )
        .await?;

    let stream_result: Result<(), BoxError> = loop {
        let Some(notification) = notifications.next().await
        else {
            break Err(
                io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Solana log subscription closed",
                )
                .into(),
            );
        };

        if notification.value.err.is_some() {
            continue;
        }

        let signature = match notification
            .value
            .signature
            .parse::<Signature>()
        {
            Ok(signature) => signature,
            Err(error) => break Err(Box::new(error)),
        };

        let wakeup = LogWakeup {
            signature,
            slot: notification.context.slot,
        };

        if let Err(error) = on_wakeup(wakeup).await {
            break Err(error);
        }
    };

    unsubscribe().await;
    drop(notifications);

    let shutdown_result = client.shutdown().await;

    stream_result?;
    shutdown_result?;

    Ok(())
}