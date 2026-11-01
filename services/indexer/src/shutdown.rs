//! Operating-system shutdown signals used by local and container runtimes.

use std::io;

use tokio::signal;

/// Waits for a graceful shutdown request.
///
/// Interactive terminals normally send SIGINT through Ctrl+C. Kubernetes and
/// Docker send SIGTERM before forcibly stopping a container.
pub async fn wait_for_shutdown() -> io::Result<&'static str> {
    #[cfg(unix)]
    {
        let mut terminate = signal::unix::signal(signal::unix::SignalKind::terminate())?;

        tokio::select! {
            result = signal::ctrl_c() => {
                result?;
                Ok("SIGINT")
            }
            _ = terminate.recv() => Ok("SIGTERM"),
        }
    }

    #[cfg(not(unix))]
    {
        signal::ctrl_c().await?;
        Ok("SIGINT")
    }
}
