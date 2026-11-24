use crate::api::ApiState;
use async_graphql::{Context, SimpleObject, Subscription};
use futures_util::Stream;
use tokio::sync::broadcast;
#[derive(SimpleObject)]
pub struct Revision {
    pub commitment: String,
    pub revision: String,
    pub resync: bool,
    /// Accounts, markets and owners this revision changed; null means the
    /// change is unknown or too large to list, so clients refresh everything.
    pub scope: Option<Vec<String>>,
}
pub struct Changes;
#[Subscription]
impl Changes {
    async fn revisions(
        &self,
        ctx: &Context<'_>,
        commitment: Option<String>,
        owner: Option<String>,
    ) -> impl Stream<Item = Revision> {
        let rx = ctx.data_unchecked::<ApiState>().revisions.subscribe();
        let level = commitment.unwrap_or_else(|| "confirmed".into());
        futures_util::stream::unfold((rx, level, owner), |(mut rx, level, owner)| async move {
            loop {
                match rx.recv().await {
                    Ok(value) => {
                        if let Some((kind, rest)) = value.split_once(':') {
                            let (revision, names) = match rest.split_once('|') {
                                Some((revision, names)) => (revision, Some(names)),
                                None => (rest, None),
                            };
                            if kind == level
                                || (kind == "wallet" && owner.as_deref() == Some(revision))
                            {
                                let item = Revision {
                                    commitment: level.clone(),
                                    revision: if kind == "wallet" {
                                        "0".into()
                                    } else {
                                        revision.into()
                                    },
                                    resync: revision == "0",
                                    scope: if kind == "wallet" {
                                        Some(vec![revision.to_owned()])
                                    } else {
                                        names.map(|n| n.split(',').map(str::to_owned).collect())
                                    },
                                };
                                return Some((item, (rx, level, owner)));
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        return Some((
                            Revision {
                                commitment: level.clone(),
                                revision: "0".into(),
                                resync: true,
                                scope: None,
                            },
                            (rx, level, owner),
                        ))
                    }
                    Err(_) => return None,
                }
            }
        })
    }
}
