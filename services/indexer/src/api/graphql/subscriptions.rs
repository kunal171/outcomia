use crate::api::ApiState;
use async_graphql::{Context, SimpleObject, Subscription};
use futures_util::Stream;
use tokio::sync::broadcast;
#[derive(SimpleObject)]
pub struct Revision {
    pub commitment: String,
    pub revision: String,
    pub resync: bool,
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
                        if let Some((kind, revision)) = value.split_once(':') {
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
