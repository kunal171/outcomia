//! Finalized log wake-ups and reconnect timing for live synchronization.
//!
//! WebSocket payloads are intentionally not treated as authoritative source
//! data. A notification only wakes the HTTP recovery path, which reloads its
//! durable boundary and fetches complete finalized transactions.

use std::{error::Error, future::Future, io, time::Duration};

use futures_util::StreamExt;
use solana_commitment_config::CommitmentConfig;
use solana_pubkey::Pubkey;
use solana_pubsub_client::nonblocking::pubsub_client::PubsubClient;
use solana_rpc_client_api::{
    config::{RpcTransactionLogsConfig, RpcTransactionLogsFilter},
    response::{Response, RpcLogsResponse},
};
use solana_signature::{ParseSignatureError, Signature};

type BoxError = Box<dyn Error + Send + Sync>;

/// A successful finalized transaction notification that should wake recovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogWakeup {
    pub signature: Signature,
    pub slot: u64,
}

/// Stateful capped exponential delay used between subscription attempts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconnectBackoff {
    initial: Duration,
    maximum: Duration,
    next: Duration,
}

impl ReconnectBackoff {
    /// Creates a non-zero delay range whose initial value does not exceed its cap.
    pub fn new(initial: Duration, maximum: Duration) -> Result<Self, io::Error> {
        if initial.is_zero() || maximum.is_zero() || initial > maximum {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "reconnect delays must be non-zero and initial must not exceed maximum",
            ));
        }

        Ok(Self {
            initial,
            maximum,
            next: initial,
        })
    }

    /// Restores the shortest delay after a healthy subscription made progress.
    pub fn reset(&mut self) {
        self.next = self.initial;
    }

    /// Returns the current delay and doubles the following delay up to the cap.
    pub fn next_delay(&mut self) -> Duration {
        let current = self.next;
        self.next = self.next.saturating_mul(2).min(self.maximum);
        current
    }
}

/// Converts a WebSocket payload into a recovery wake-up.
///
/// Failed transactions emitted logs but rolled their state back, so they are
/// ignored. Invalid successful signatures are errors because silently dropping
/// the wake-up could delay recovery until an unrelated later transaction.
fn notification_to_wakeup(
    notification: Response<RpcLogsResponse>,
) -> Result<Option<LogWakeup>, ParseSignatureError> {
    if notification.value.err.is_some() {
        return Ok(None);
    }

    Ok(Some(LogWakeup {
        signature: notification.value.signature.parse()?,
        slot: notification.context.slot,
    }))
}

/// Subscribes to finalized Tidebook logs and serially invokes recovery hooks.
///
/// `on_ready` runs after the subscription is active but before notifications
/// are consumed. Notifications arriving during that HTTP catch-up remain
/// buffered by the client, closing the startup race between catch-up and
/// subscription establishment. Callback failures close the subscription so the
/// outer runtime can reconnect and recover again from its durable checkpoint.
pub async fn run_log_subscription<OnReady, ReadyFuture, OnWakeup, WakeupFuture>(
    websocket_url: &str,
    program_id: &Pubkey,
    mut on_ready: OnReady,
    mut on_wakeup: OnWakeup,
) -> Result<(), BoxError>
where
    OnReady: FnMut() -> ReadyFuture,
    ReadyFuture: Future<Output = Result<(), BoxError>>,
    OnWakeup: FnMut(LogWakeup) -> WakeupFuture,
    WakeupFuture: Future<Output = Result<(), BoxError>>,
{
    let client = PubsubClient::new(websocket_url).await?;

    let (mut notifications, unsubscribe) = client
        .logs_subscribe(
            RpcTransactionLogsFilter::Mentions(vec![program_id.to_string()]),
            RpcTransactionLogsConfig {
                commitment: Some(CommitmentConfig::finalized()),
            },
        )
        .await?;

    let stream_result: Result<(), BoxError> = async {
        on_ready().await?;

        loop {
            let notification = notifications.next().await.ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "Solana log subscription closed",
                )
            })?;

            if let Some(wakeup) = notification_to_wakeup(notification)? {
                on_wakeup(wakeup).await?;
            }
        }
    }
    .await;

    unsubscribe().await;
    drop(notifications);

    let shutdown_result = client.shutdown().await;

    stream_result?;
    shutdown_result?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use solana_rpc_client_api::response::{RpcResponseContext, UiTransactionError};

    use super::*;

    fn notification(signature: String, slot: u64, failed: bool) -> Response<RpcLogsResponse> {
        let err = failed.then(|| {
            serde_json::from_str::<UiTransactionError>(r#""AccountNotFound""#)
                .expect("test transaction error must deserialize")
        });

        Response {
            context: RpcResponseContext {
                slot,
                api_version: None,
            },
            value: RpcLogsResponse {
                signature,
                err,
                logs: Vec::new(),
            },
        }
    }

    #[test]
    fn successful_notification_becomes_a_wakeup() {
        let signature = Signature::from([7; 64]);

        let wakeup = notification_to_wakeup(notification(signature.to_string(), 42, false))
            .expect("valid notification must parse")
            .expect("successful notification must wake recovery");

        assert_eq!(wakeup.signature, signature);
        assert_eq!(wakeup.slot, 42);
    }

    #[test]
    fn failed_notification_is_ignored() {
        let result = notification_to_wakeup(notification("not-a-signature".to_owned(), 42, true))
            .expect("failed notification must be ignored before signature parsing");

        assert_eq!(result, None);
    }

    #[test]
    fn invalid_successful_signature_is_rejected() {
        notification_to_wakeup(notification("not-a-signature".to_owned(), 42, false))
            .expect_err("malformed successful signature must fail closed");
    }

    #[test]
    fn reconnect_backoff_doubles_to_cap_and_resets() {
        let mut backoff = ReconnectBackoff::new(Duration::from_secs(1), Duration::from_secs(8))
            .expect("valid reconnect range must construct");

        assert_eq!(
            (0..5).map(|_| backoff.next_delay()).collect::<Vec<_>>(),
            [1, 2, 4, 8, 8].map(Duration::from_secs)
        );

        backoff.reset();
        assert_eq!(backoff.next_delay(), Duration::from_secs(1));
    }

    #[test]
    fn invalid_reconnect_backoff_is_rejected() {
        for (initial, maximum) in [(0, 1), (1, 0), (2, 1)] {
            let error =
                ReconnectBackoff::new(Duration::from_secs(initial), Duration::from_secs(maximum))
                    .expect_err("invalid reconnect range must fail");

            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        }
    }
}
