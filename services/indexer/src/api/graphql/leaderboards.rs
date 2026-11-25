//! Leaderboards, trader statistics and per-market traders.
//!
//! Amounts are raw atoms of one mint and are never summed across mints.
//! Position and profit math lives in the SQL views of migration
//! 20261125090000 (`trade_legs`, `position_legs`, `resolved_market_results`).
//!
//! Dynamic SQL here only interpolates fixed fragments from this file and
//! validated integers; every user-supplied value is a bound parameter.
use super::profiles::{profiles_for, Profile};
use crate::api::ApiState;
use async_graphql::{Context, Enum, Object, SimpleObject};
use sqlx::{PgPool, Row};

/// Placeholder maker of the taker leg in a multi-outcome complementary fill.
const SET_ADDRESS: &str = "11111111111111111111111111111111";

/// Wallets whose owners opted out of public rankings.
fn visible(column: &str) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM profiles hidden WHERE hidden.wallet = {column} AND NOT hidden.show_on_leaderboards)"
    )
}

/// Time filter on a unix-seconds column; `$n` is NULL for all time.
fn within(column: &str, param: usize) -> String {
    format!(
        "(${param}::bigint IS NULL OR {column} >= EXTRACT(EPOCH FROM NOW())::bigint - ${param})"
    )
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
pub enum Period {
    Day,
    Week,
    Month,
    All,
}
impl Period {
    fn seconds(self) -> Option<i64> {
        match self {
            Period::Day => Some(86_400),
            Period::Week => Some(7 * 86_400),
            Period::Month => Some(30 * 86_400),
            Period::All => None,
        }
    }
}

#[derive(Enum, Copy, Clone, Eq, PartialEq)]
pub enum TraderBoard {
    /// Traded value, excluding trades against oneself.
    Volume,
    /// Number of fills, then distinct markets.
    Activity,
    /// Value filled as the resting (maker) order.
    Makers,
    /// Realized profit on resolved prediction markets (all time).
    Profit,
    /// Share of resolved markets closed in profit (all time).
    Accuracy,
}

#[derive(SimpleObject)]
pub struct TraderRow {
    pub rank: i32,
    pub wallet: String,
    pub profile: Option<Profile>,
    pub volume: Option<String>,
    pub maker_volume: Option<String>,
    pub trades: Option<i64>,
    pub markets: Option<i64>,
    pub profit: Option<String>,
    pub invested: Option<String>,
    pub wins: Option<i64>,
    pub losses: Option<i64>,
}

#[derive(SimpleObject)]
pub struct MarketRow {
    pub rank: i32,
    pub market: String,
    pub kind: String,
    pub title: Option<String>,
    pub volume: String,
    pub trades: i64,
    pub traders: i64,
}

#[derive(SimpleObject)]
pub struct CallRow {
    pub rank: i32,
    pub wallet: String,
    pub profile: Option<Profile>,
    pub market: String,
    pub kind: String,
    pub title: Option<String>,
    pub outcome: String,
    pub outcome_label: Option<String>,
    pub price: String,
    pub payout: String,
    pub quantity: String,
    pub profit: String,
    /// Payout divided by entry price, two decimals.
    pub multiple: String,
    pub signature: String,
    pub block_time: Option<String>,
}

#[derive(SimpleObject)]
pub struct ClubRow {
    pub rank: i32,
    pub club: String,
    pub name: String,
    pub members: i64,
    pub markets: i64,
    pub volume: String,
    pub trades: i64,
}

#[derive(SimpleObject)]
pub struct CreatorRow {
    pub rank: i32,
    pub wallet: String,
    pub profile: Option<Profile>,
    pub markets: i64,
    pub volume: String,
    pub traders: i64,
}

#[derive(SimpleObject)]
pub struct MintRow {
    pub mint: String,
    pub decimals: Option<i32>,
    /// Most common quote symbol in its markets' metadata, if any.
    pub symbol: Option<String>,
    pub volume: String,
}

#[derive(SimpleObject)]
pub struct MintStats {
    pub mint: String,
    pub decimals: Option<i32>,
    pub volume: String,
    pub maker_volume: String,
    pub trades: i64,
    pub markets: i64,
    pub profit: String,
    pub wins: i64,
    pub losses: i64,
}

#[derive(SimpleObject)]
pub struct OpenPosition {
    pub market: String,
    pub kind: String,
    pub title: Option<String>,
    pub mint: Option<String>,
    pub outcome: String,
    pub outcome_label: Option<String>,
    pub contracts: String,
}

#[derive(SimpleObject)]
pub struct SettledMarket {
    pub market: String,
    pub kind: String,
    pub title: Option<String>,
    pub mint: String,
    pub profit: String,
}

#[derive(SimpleObject)]
pub struct TradeLeg {
    pub signature: String,
    pub block_time: Option<String>,
    pub market: String,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub mint: Option<String>,
    pub outcome: String,
    pub outcome_label: Option<String>,
    pub role: String,
    /// Contracts (or base units for spot) gained; negative when given.
    pub contracts: String,
    pub price: String,
}

#[derive(SimpleObject)]
pub struct ClubMembership {
    pub club: String,
    pub name: Option<String>,
    pub role: String,
}

#[derive(SimpleObject)]
pub struct TraderStats {
    pub wallet: String,
    pub profile: Option<Profile>,
    pub per_mint: Vec<MintStats>,
    pub open_positions: Vec<OpenPosition>,
    pub settled: Vec<SettledMarket>,
    pub recent_trades: Vec<TradeLeg>,
    pub clubs: Vec<ClubMembership>,
}

#[derive(SimpleObject)]
pub struct OutcomeHolding {
    pub outcome: String,
    pub label: Option<String>,
    pub contracts: String,
}

#[derive(SimpleObject)]
pub struct MarketTraderRow {
    pub rank: i32,
    pub wallet: String,
    pub profile: Option<Profile>,
    pub volume: String,
    pub trades: i64,
    pub holdings: Vec<OutcomeHolding>,
    /// Realized profit once the market is resolved.
    pub profit: Option<String>,
}

fn page(first: Option<i32>, offset: Option<i32>) -> async_graphql::Result<(i64, i64)> {
    let first = first.unwrap_or(25);
    let offset = offset.unwrap_or(0);
    if !(1..=100).contains(&first) || !(0..=10_000).contains(&offset) {
        return Err("Ask for 1–100 rows from an offset up to 10,000".into());
    }
    Ok((i64::from(first), i64::from(offset)))
}

fn check_address(value: &str) -> async_graphql::Result<()> {
    value
        .parse::<solana_pubkey::Pubkey>()
        .map(|_| ())
        .map_err(|_| "Invalid address".into())
}

async fn attach(
    pool: &PgPool,
    wallets: Vec<String>,
) -> sqlx::Result<std::collections::HashMap<String, Profile>> {
    profiles_for(pool, &wallets).await
}

fn rank(offset: i64, index: usize) -> i32 {
    i32::try_from(offset).unwrap_or(0) + i32::try_from(index).unwrap_or(0) + 1
}

#[derive(Default)]
pub struct LeaderboardsQuery;
#[Object]
impl LeaderboardsQuery {
    /// Mints that have trades, largest volume first, for the token switch.
    async fn leaderboard_mints(&self, ctx: &Context<'_>) -> async_graphql::Result<Vec<MintRow>> {
        let pool = &ctx.data::<ApiState>()?.pool;
        let rows = sqlx::query(
            "SELECT a.mint, MAX(mc.decimals) AS decimals, SUM(t.quote_atoms)::text AS volume,
                    (SELECT md.data->>'quoteSymbol' FROM indexed_accounts md
                       JOIN market_assets s ON s.market = md.data->>'market'
                      WHERE md.account_type = 'MarketMetadata' AND s.mint = a.mint
                        AND COALESCE(md.data->>'quoteSymbol', '') <> ''
                      GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 1) AS symbol
               FROM indexed_trades t JOIN market_assets a ON a.market = t.market
               LEFT JOIN mint_cache mc ON mc.address = a.mint
              WHERE a.mint IS NOT NULL AND t.maker <> t.taker
              GROUP BY a.mint ORDER BY SUM(t.quote_atoms) DESC, a.mint",
        )
        .fetch_all(pool)
        .await?;
        Ok(rows
            .iter()
            .map(|r| MintRow {
                mint: r.get("mint"),
                decimals: r.get::<Option<i16>, _>("decimals").map(i32::from),
                symbol: r.get("symbol"),
                volume: r.get("volume"),
            })
            .collect())
    }

    /// The latest indexed trade slot; leaderboards are current as of it.
    async fn leaderboard_slot(&self, ctx: &Context<'_>) -> async_graphql::Result<Option<String>> {
        let pool = &ctx.data::<ApiState>()?.pool;
        Ok(
            sqlx::query_scalar("SELECT MAX(slot)::text FROM indexed_trades")
                .fetch_one(pool)
                .await?,
        )
    }

    /// Ranks wallets for one mint. Profit and accuracy cover resolved
    /// prediction markets and ignore `period`; accuracy needs `minMarkets`
    /// decided (non-zero result) markets, default 3.
    #[allow(clippy::too_many_arguments)]
    async fn trader_leaderboard(
        &self,
        ctx: &Context<'_>,
        board: TraderBoard,
        period: Period,
        mint: String,
        first: Option<i32>,
        offset: Option<i32>,
        min_markets: Option<i32>,
    ) -> async_graphql::Result<Vec<TraderRow>> {
        check_address(&mint)?;
        let (first, offset) = page(first, offset)?;
        let pool = &ctx.data::<ApiState>()?.pool;
        let rows = match board {
            TraderBoard::Volume | TraderBoard::Activity | TraderBoard::Makers => {
                let order = match board {
                    TraderBoard::Volume => "SUM(l.volume) DESC",
                    TraderBoard::Activity => "COUNT(*) DESC, COUNT(DISTINCT l.market) DESC",
                    _ => "SUM(l.volume) FILTER (WHERE l.role = 'maker') DESC NULLS LAST",
                };
                let makers_only = if board == TraderBoard::Makers {
                    "HAVING COUNT(*) FILTER (WHERE l.role = 'maker') > 0"
                } else {
                    ""
                };
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "SELECT l.wallet, SUM(l.volume)::text AS volume,
                            COALESCE(SUM(l.volume) FILTER (WHERE l.role = 'maker'), 0)::text AS maker_volume,
                            COUNT(*) AS trades, COUNT(DISTINCT l.market) AS markets
                       FROM trade_legs l JOIN market_assets a ON a.market = l.market
                      WHERE a.mint = $1 AND l.wallet <> l.counterparty AND l.wallet <> '{SET_ADDRESS}'
                        AND {within} AND {visible}
                      GROUP BY l.wallet {makers_only}
                      ORDER BY {order}, l.wallet LIMIT $3 OFFSET $4",
                    within = within("l.block_time", 2),
                    visible = visible("l.wallet"),
                )))
                .bind(&mint)
                .bind(period.seconds())
                .bind(first)
                .bind(offset)
                .fetch_all(pool)
                .await?
                .iter()
                .map(|r| TraderRow {
                    rank: 0,
                    wallet: r.get("wallet"),
                    profile: None,
                    volume: Some(r.get("volume")),
                    maker_volume: Some(r.get("maker_volume")),
                    trades: Some(r.get("trades")),
                    markets: Some(r.get("markets")),
                    profit: None,
                    invested: None,
                    wins: None,
                    losses: None,
                })
                .collect::<Vec<_>>()
            }
            TraderBoard::Profit | TraderBoard::Accuracy => {
                let (order, having) = if board == TraderBoard::Profit {
                    ("SUM(r.profit) DESC", String::new())
                } else {
                    let min = min_markets.unwrap_or(3);
                    if !(1..=1000).contains(&min) {
                        return Err("minMarkets must be between 1 and 1000".into());
                    }
                    (
                        "COUNT(*) FILTER (WHERE r.profit > 0)::numeric / NULLIF(COUNT(*) FILTER (WHERE r.profit <> 0), 0) DESC NULLS LAST, COUNT(*) FILTER (WHERE r.profit > 0) DESC",
                        format!("HAVING COUNT(*) FILTER (WHERE r.profit <> 0) >= {min}"),
                    )
                };
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "SELECT r.wallet, SUM(r.profit)::text AS profit, SUM(r.invested)::text AS invested,
                            COUNT(*) FILTER (WHERE r.profit > 0) AS wins,
                            COUNT(*) FILTER (WHERE r.profit < 0) AS losses, COUNT(*) AS markets
                       FROM resolved_market_results r
                      WHERE r.mint = $1 AND r.wallet <> '{SET_ADDRESS}' AND {visible}
                      GROUP BY r.wallet {having}
                      ORDER BY {order}, r.wallet LIMIT $2 OFFSET $3",
                    visible = visible("r.wallet"),
                )))
                .bind(&mint)
                .bind(first)
                .bind(offset)
                .fetch_all(pool)
                .await?
                .iter()
                .map(|r| TraderRow {
                    rank: 0,
                    wallet: r.get("wallet"),
                    profile: None,
                    volume: None,
                    maker_volume: None,
                    trades: None,
                    markets: Some(r.get("markets")),
                    profit: Some(r.get("profit")),
                    invested: Some(r.get("invested")),
                    wins: Some(r.get("wins")),
                    losses: Some(r.get("losses")),
                })
                .collect::<Vec<_>>()
            }
        };
        let mut profiles = attach(pool, rows.iter().map(|r| r.wallet.clone()).collect()).await?;
        Ok(rows
            .into_iter()
            .enumerate()
            .map(|(i, mut row)| {
                row.rank = rank(offset, i);
                row.profile = profiles.remove(&row.wallet);
                row
            })
            .collect())
    }

    /// Most traded markets for one mint.
    async fn market_leaderboard(
        &self,
        ctx: &Context<'_>,
        period: Period,
        mint: String,
        first: Option<i32>,
        offset: Option<i32>,
    ) -> async_graphql::Result<Vec<MarketRow>> {
        check_address(&mint)?;
        let (first, offset) = page(first, offset)?;
        let pool = &ctx.data::<ApiState>()?.pool;
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "WITH legs AS (
                 SELECT l.market, l.wallet FROM trade_legs l
                  WHERE l.wallet <> '{SET_ADDRESS}' AND {legs_within})
             SELECT t.market, a.kind, a.title, SUM(t.quote_atoms)::text AS volume, COUNT(*) AS trades,
                    (SELECT COUNT(DISTINCT legs.wallet) FROM legs WHERE legs.market = t.market) AS traders
               FROM indexed_trades t JOIN market_assets a ON a.market = t.market
              WHERE a.mint = $1 AND t.maker <> t.taker AND {within}
              GROUP BY t.market, a.kind, a.title
              ORDER BY SUM(t.quote_atoms) DESC, t.market LIMIT $3 OFFSET $4",
            legs_within = within("l.block_time", 2),
            within = within("t.block_time", 2),
        )))
        .bind(&mint)
        .bind(period.seconds())
        .bind(first)
        .bind(offset)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .iter()
            .enumerate()
            .map(|(i, r)| MarketRow {
                rank: rank(offset, i),
                market: r.get("market"),
                kind: r.get("kind"),
                title: r.get("title"),
                volume: r.get("volume"),
                trades: r.get("trades"),
                traders: r.get("traders"),
            })
            .collect())
    }

    /// Winning entries bought cheapest relative to their payout (all time).
    async fn best_calls(
        &self,
        ctx: &Context<'_>,
        mint: String,
        first: Option<i32>,
    ) -> async_graphql::Result<Vec<CallRow>> {
        check_address(&mint)?;
        let (first, _) = page(first, None)?;
        let pool = &ctx.data::<ApiState>()?.pool;
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT l.wallet, l.market, a.kind, a.title, l.outcome,
                    a.labels->>(l.outcome::int) AS outcome_label,
                    l.price::text AS price, mp.payout::text AS payout, l.contracts::text AS quantity,
                    (l.contracts * (mp.payout - l.price))::text AS profit,
                    round(mp.payout / l.price, 2)::text AS multiple,
                    l.signature, l.block_time::text AS block_time
               FROM trade_legs l
               JOIN market_outcome_payouts mp ON mp.market = l.market AND mp.outcome = l.outcome
               JOIN market_assets a ON a.market = l.market
              WHERE a.mint = $1 AND l.contracts > 0 AND NOT mp.invalid
                AND l.price > 0 AND l.price < mp.payout AND l.wallet <> l.counterparty
                AND l.wallet <> '{SET_ADDRESS}' AND {visible}
              ORDER BY mp.payout / l.price DESC, l.contracts * (mp.payout - l.price) DESC, l.execution_id
              LIMIT $2",
            visible = visible("l.wallet"),
        )))
        .bind(&mint)
        .bind(first)
        .fetch_all(pool)
        .await?;
        let profiles = attach(pool, rows.iter().map(|r| r.get("wallet")).collect()).await?;
        Ok(rows
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let wallet: String = r.get("wallet");
                CallRow {
                    rank: rank(0, i),
                    profile: profiles.get(&wallet).cloned(),
                    wallet,
                    market: r.get("market"),
                    kind: r.get("kind"),
                    title: r.get("title"),
                    outcome: r.get("outcome"),
                    outcome_label: r.get("outcome_label"),
                    price: r.get("price"),
                    payout: r.get("payout"),
                    quantity: r.get("quantity"),
                    profit: r.get("profit"),
                    multiple: r.get("multiple"),
                    signature: r.get("signature"),
                    block_time: r.get("block_time"),
                }
            })
            .collect())
    }

    /// Clubs by traded value in their markets for one mint, then members.
    async fn club_leaderboard(
        &self,
        ctx: &Context<'_>,
        period: Period,
        mint: String,
        first: Option<i32>,
    ) -> async_graphql::Result<Vec<ClubRow>> {
        check_address(&mint)?;
        let (first, _) = page(first, None)?;
        let pool = &ctx.data::<ApiState>()?.pool;
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "WITH clubs AS (
                 SELECT DISTINCT ON (address) address, data->>'name' AS name,
                        COALESCE((data->>'memberCount')::bigint, 0) AS members
                   FROM indexed_accounts WHERE account_type = 'Club' AND NOT deleted
                  ORDER BY address, (commitment = 'confirmed') DESC, slot DESC),
             club_markets AS (
                 SELECT DISTINCT data->>'club' AS club, data->>'market' AS market
                   FROM indexed_accounts WHERE account_type = 'ClubMarket'),
             volume AS (
                 SELECT t.market, SUM(t.quote_atoms) AS volume, COUNT(*) AS trades
                   FROM indexed_trades t JOIN market_assets a ON a.market = t.market
                  WHERE a.mint = $1 AND t.maker <> t.taker AND {within}
                  GROUP BY t.market)
             SELECT c.address, c.name, c.members, COUNT(DISTINCT cm.market) AS markets,
                    COALESCE(SUM(v.volume), 0)::text AS volume, COALESCE(SUM(v.trades), 0)::bigint AS trades
               FROM clubs c LEFT JOIN club_markets cm ON cm.club = c.address
               LEFT JOIN volume v ON v.market = cm.market
              GROUP BY c.address, c.name, c.members
              ORDER BY COALESCE(SUM(v.volume), 0) DESC, c.members DESC, c.address LIMIT $3",
            within = within("t.block_time", 2),
        )))
        .bind(&mint)
        .bind(period.seconds())
        .bind(first)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .iter()
            .enumerate()
            .map(|(i, r)| ClubRow {
                rank: rank(0, i),
                club: r.get("address"),
                name: r.get::<Option<String>, _>("name").unwrap_or_default(),
                members: r.get("members"),
                markets: r.get("markets"),
                volume: r.get("volume"),
                trades: r.get("trades"),
            })
            .collect())
    }

    /// Market creators by the traded value their prediction markets drew.
    async fn creator_leaderboard(
        &self,
        ctx: &Context<'_>,
        period: Period,
        mint: String,
        first: Option<i32>,
    ) -> async_graphql::Result<Vec<CreatorRow>> {
        check_address(&mint)?;
        let (first, _) = page(first, None)?;
        let pool = &ctx.data::<ApiState>()?.pool;
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "WITH club_creators AS (
                 SELECT DISTINCT ON (data->>'market') data->>'market' AS market, data->>'creator' AS creator
                   FROM indexed_accounts WHERE account_type = 'ClubMarket'
                  ORDER BY data->>'market', (commitment = 'confirmed') DESC, slot DESC),
             creators AS (
                 SELECT a.market, COALESCE(cc.creator, a.creator) AS creator
                   FROM market_assets a LEFT JOIN club_creators cc ON cc.market = a.market
                  WHERE a.mint = $1 AND a.kind IN ('BINARY', 'MULTI') AND a.creator IS NOT NULL),
             volume AS (
                 SELECT t.market, SUM(t.quote_atoms) AS volume FROM indexed_trades t
                  WHERE t.maker <> t.taker AND {within} GROUP BY t.market),
             traders AS (
                 SELECT DISTINCT c.creator, l.wallet FROM trade_legs l JOIN creators c ON c.market = l.market
                  WHERE l.wallet <> '{SET_ADDRESS}' AND {legs_within})
             SELECT c.creator AS wallet, COUNT(*) AS markets, COALESCE(SUM(v.volume), 0)::text AS volume,
                    (SELECT COUNT(*) FROM traders tr WHERE tr.creator = c.creator) AS traders
               FROM creators c LEFT JOIN volume v ON v.market = c.market
              WHERE {visible}
              GROUP BY c.creator
              ORDER BY COALESCE(SUM(v.volume), 0) DESC, COUNT(*) DESC, c.creator LIMIT $3",
            within = within("t.block_time", 2),
            legs_within = within("l.block_time", 2),
            visible = visible("c.creator"),
        )))
        .bind(&mint)
        .bind(period.seconds())
        .bind(first)
        .fetch_all(pool)
        .await?;
        let mut profiles = attach(pool, rows.iter().map(|r| r.get("wallet")).collect()).await?;
        Ok(rows
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let wallet: String = r.get("wallet");
                CreatorRow {
                    rank: rank(0, i),
                    profile: profiles.remove(&wallet),
                    wallet,
                    markets: r.get("markets"),
                    volume: r.get("volume"),
                    traders: r.get("traders"),
                }
            })
            .collect())
    }

    /// Everything a profile page shows about one wallet's trading.
    async fn trader_stats(
        &self,
        ctx: &Context<'_>,
        wallet: String,
    ) -> async_graphql::Result<TraderStats> {
        check_address(&wallet)?;
        let pool = &ctx.data::<ApiState>()?.pool;
        let per_mint = sqlx::query(
            "WITH legs AS (
                 SELECT a.mint, l.* FROM trade_legs l JOIN market_assets a ON a.market = l.market
                  WHERE l.wallet = $1 AND l.wallet <> l.counterparty AND a.mint IS NOT NULL),
             traded AS (
                 SELECT mint, SUM(volume) AS volume,
                        COALESCE(SUM(volume) FILTER (WHERE role = 'maker'), 0) AS maker_volume,
                        COUNT(*) AS trades, COUNT(DISTINCT market) AS markets
                   FROM legs GROUP BY mint),
             settled AS (
                 SELECT mint, SUM(profit) AS profit,
                        COUNT(*) FILTER (WHERE profit > 0) AS wins,
                        COUNT(*) FILTER (WHERE profit < 0) AS losses
                   FROM resolved_market_results WHERE wallet = $1 GROUP BY mint)
             SELECT COALESCE(t.mint, s.mint) AS mint, mc.decimals,
                    COALESCE(t.volume, 0)::text AS volume, COALESCE(t.maker_volume, 0)::text AS maker_volume,
                    COALESCE(t.trades, 0) AS trades, COALESCE(t.markets, 0) AS markets,
                    COALESCE(s.profit, 0)::text AS profit,
                    COALESCE(s.wins, 0) AS wins, COALESCE(s.losses, 0) AS losses
               FROM traded t FULL JOIN settled s ON s.mint = t.mint
               LEFT JOIN mint_cache mc ON mc.address = COALESCE(t.mint, s.mint)
              ORDER BY COALESCE(t.volume, 0) DESC, 1",
        )
        .bind(&wallet)
        .fetch_all(pool)
        .await?
        .iter()
        .map(|r| MintStats {
            mint: r.get("mint"),
            decimals: r.get::<Option<i16>, _>("decimals").map(i32::from),
            volume: r.get("volume"),
            maker_volume: r.get("maker_volume"),
            trades: r.get("trades"),
            markets: r.get("markets"),
            profit: r.get("profit"),
            wins: r.get("wins"),
            losses: r.get("losses"),
        })
        .collect();
        let open_positions = sqlx::query(
            "SELECT p.market, a.kind, a.title, a.mint, p.outcome,
                    a.labels->>(p.outcome::int) AS outcome_label, SUM(p.contracts)::text AS contracts
               FROM position_legs p JOIN market_assets a ON a.market = p.market
              WHERE p.wallet = $1 AND NOT (COALESCE(a.status, '{}'::jsonb) ? 'resolved')
              GROUP BY p.market, a.kind, a.title, a.mint, p.outcome, a.labels
             HAVING SUM(p.contracts) <> 0
              ORDER BY a.title NULLS LAST, p.market, p.outcome LIMIT 100",
        )
        .bind(&wallet)
        .fetch_all(pool)
        .await?
        .iter()
        .map(|r| OpenPosition {
            market: r.get("market"),
            kind: r.get("kind"),
            title: r.get("title"),
            mint: r.get("mint"),
            outcome: r.get("outcome"),
            outcome_label: r.get("outcome_label"),
            contracts: r.get("contracts"),
        })
        .collect();
        let settled = sqlx::query(
            "SELECT r.market, a.kind, a.title, r.mint, r.profit::text AS profit
               FROM resolved_market_results r JOIN market_assets a ON a.market = r.market
              WHERE r.wallet = $1 ORDER BY r.profit DESC, r.market LIMIT 50",
        )
        .bind(&wallet)
        .fetch_all(pool)
        .await?
        .iter()
        .map(|r| SettledMarket {
            market: r.get("market"),
            kind: r.get("kind"),
            title: r.get("title"),
            mint: r.get("mint"),
            profit: r.get("profit"),
        })
        .collect();
        let recent_trades = sqlx::query(
            "SELECT l.signature, l.block_time::text AS block_time, l.market, a.kind, a.title, a.mint,
                    l.outcome, a.labels->>(CASE WHEN l.outcome ~ '^[0-9]+$' THEN l.outcome::int ELSE 0 END) AS outcome_label,
                    l.role, l.contracts::text AS contracts, l.price::text AS price
               FROM trade_legs l LEFT JOIN market_assets a ON a.market = l.market
              WHERE l.wallet = $1
              ORDER BY l.slot DESC, l.transaction_index DESC NULLS LAST, l.execution_index DESC LIMIT 25",
        )
        .bind(&wallet)
        .fetch_all(pool)
        .await?
        .iter()
        .map(|r| TradeLeg {
            signature: r.get("signature"),
            block_time: r.get("block_time"),
            market: r.get("market"),
            kind: r.get("kind"),
            title: r.get("title"),
            mint: r.get("mint"),
            outcome: r.get("outcome"),
            outcome_label: r.get("outcome_label"),
            role: r.get("role"),
            contracts: r.get("contracts"),
            price: r.get("price"),
        })
        .collect();
        let clubs = sqlx::query(
            "SELECT DISTINCT ON (m.data->>'club') m.data->>'club' AS club,
                    (SELECT c.data->>'name' FROM indexed_accounts c
                      WHERE c.account_type = 'Club' AND c.address = m.data->>'club'
                      ORDER BY (c.commitment = 'confirmed') DESC LIMIT 1) AS name,
                    (SELECT k FROM jsonb_object_keys(m.data->'role') k LIMIT 1) AS role
               FROM indexed_accounts m
              WHERE m.account_type = 'ClubMember' AND NOT m.deleted AND m.data->>'wallet' = $1
              ORDER BY m.data->>'club', (m.commitment = 'confirmed') DESC",
        )
        .bind(&wallet)
        .fetch_all(pool)
        .await?
        .iter()
        .map(|r| ClubMembership {
            club: r.get("club"),
            name: r.get("name"),
            role: r
                .get::<Option<String>, _>("role")
                .unwrap_or_else(|| "member".into()),
        })
        .collect();
        let profile = attach(pool, vec![wallet.clone()]).await?.remove(&wallet);
        Ok(TraderStats {
            wallet,
            profile,
            per_mint,
            open_positions,
            settled,
            recent_trades,
            clubs,
        })
    }

    /// Wallets that traded one market, by value traded, with their holdings.
    async fn market_traders(
        &self,
        ctx: &Context<'_>,
        market: String,
        first: Option<i32>,
    ) -> async_graphql::Result<Vec<MarketTraderRow>> {
        check_address(&market)?;
        let (first, _) = page(first, None)?;
        let pool = &ctx.data::<ApiState>()?.pool;
        let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT l.wallet, COALESCE(SUM(l.volume) FILTER (WHERE l.wallet <> l.counterparty), 0)::text AS volume,
                    COUNT(*) AS trades
               FROM trade_legs l
              WHERE l.market = $1 AND l.wallet <> '{SET_ADDRESS}' AND {visible}
              GROUP BY l.wallet
              ORDER BY COALESCE(SUM(l.volume) FILTER (WHERE l.wallet <> l.counterparty), 0) DESC, l.wallet
              LIMIT $2",
            visible = visible("l.wallet"),
        )))
        .bind(&market)
        .bind(first)
        .fetch_all(pool)
        .await?;
        let wallets: Vec<String> = rows.iter().map(|r| r.get("wallet")).collect();
        let holdings = sqlx::query(
            "SELECT p.wallet, p.outcome, a.labels->>(p.outcome::int) AS label, SUM(p.contracts)::text AS contracts
               FROM position_legs p JOIN market_assets a ON a.market = p.market
              WHERE p.market = $1 AND p.wallet = ANY($2)
              GROUP BY p.wallet, p.outcome, a.labels HAVING SUM(p.contracts) <> 0
              ORDER BY p.wallet, p.outcome::int",
        )
        .bind(&market)
        .bind(&wallets)
        .fetch_all(pool)
        .await?;
        let profits = sqlx::query(
            "SELECT wallet, profit::text AS profit FROM resolved_market_results WHERE market = $1 AND wallet = ANY($2)",
        )
        .bind(&market)
        .bind(&wallets)
        .fetch_all(pool)
        .await?;
        let mut profiles = attach(pool, wallets).await?;
        Ok(rows
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let wallet: String = r.get("wallet");
                MarketTraderRow {
                    rank: rank(0, i),
                    profile: profiles.remove(&wallet),
                    volume: r.get("volume"),
                    trades: r.get("trades"),
                    holdings: holdings
                        .iter()
                        .filter(|h| h.get::<String, _>("wallet") == wallet)
                        .map(|h| OutcomeHolding {
                            outcome: h.get("outcome"),
                            label: h.get("label"),
                            contracts: h.get("contracts"),
                        })
                        .collect(),
                    profit: profits
                        .iter()
                        .find(|p| p.get::<String, _>("wallet") == wallet)
                        .map(|p| p.get("profit")),
                    wallet,
                }
            })
            .collect())
    }
}
