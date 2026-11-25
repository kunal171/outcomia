//! GraphQL domain objects; HTTP/session handling lives in the parent module.
mod accounts;
mod charts;
mod leaderboards;
mod markets;
mod profiles;
mod receipts;
mod subscriptions;
mod wallet;
use async_graphql::MergedObject;
pub use subscriptions::Changes;
#[derive(MergedObject, Default)]
pub struct Query(
    accounts::AccountsQuery,
    markets::MarketsQuery,
    wallet::WalletQuery,
    charts::ChartsQuery,
    receipts::ReceiptsQuery,
    profiles::ProfilesQuery,
    leaderboards::LeaderboardsQuery,
);
#[derive(MergedObject, Default)]
pub struct Mutation(profiles::ProfilesMutation);
