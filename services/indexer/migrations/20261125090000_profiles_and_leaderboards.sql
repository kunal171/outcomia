-- Public profiles are optional presentation data owned by a signed-in wallet.
-- Only the GraphQL mutation for the same wallet's session writes them.
CREATE TABLE profiles (
    wallet TEXT PRIMARY KEY REFERENCES users(wallet_address) ON DELETE CASCADE,
    username TEXT NOT NULL CHECK (username ~ '^[a-z0-9_]{3,20}$'),
    display_name TEXT NOT NULL DEFAULT '' CHECK (char_length(display_name) <= 40),
    bio TEXT NOT NULL DEFAULT '' CHECK (char_length(bio) <= 280),
    avatar_hue SMALLINT NOT NULL DEFAULT 210 CHECK (avatar_hue BETWEEN 0 AND 359),
    x_handle TEXT CHECK (x_handle ~ '^[A-Za-z0-9_]{1,15}$'),
    show_on_leaderboards BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX profiles_username ON profiles(username);

-- Multi-outcome complement legs are found by their sibling in the same transaction.
CREATE INDEX indexed_trades_signature ON indexed_trades(signature);

-- One row per market: its collateral or quote mint, payout terms and result.
-- Closed accounts keep their last data, so settled history stays priced.
CREATE VIEW market_assets AS
SELECT DISTINCT ON (m.market)
    m.market, m.kind, m.mint, m.payout, m.outcome_count, m.labels,
    m.status, m.final_outcome, m.creator,
    (SELECT md.data->>'displayName' FROM indexed_accounts md
      WHERE md.account_type = 'MarketMetadata' AND md.data->>'market' = m.market
      ORDER BY (md.commitment = 'confirmed') DESC, md.slot DESC LIMIT 1) AS title
FROM (
    SELECT address AS market, 'BINARY' AS kind, data->>'collateralMint' AS mint,
           (data->>'payoutPerContract')::numeric AS payout, 2 AS outcome_count,
           '["Yes","No"]'::jsonb AS labels, data->'status' AS status,
           data->'finalOutcome' AS final_outcome, data->>'authority' AS creator,
           commitment, slot
      FROM indexed_accounts WHERE account_type = 'PredictionMarket'
    UNION ALL
    SELECT address, 'MULTI', data->>'collateralMint',
           (data->'terms'->>'payoutPerContract')::numeric,
           jsonb_array_length(data->'terms'->'outcomeLabels'),
           data->'terms'->'outcomeLabels', data->'status',
           data->'finalOutcome', data->>'authority', commitment, slot
      FROM indexed_accounts WHERE account_type = 'MultiOutcomeMarket'
    UNION ALL
    SELECT address, 'SPOT', data->>'quoteMint', NULL, 1, '["Spot"]'::jsonb,
           data->'status', NULL, data->>'authority', commitment, slot
      FROM indexed_accounts WHERE account_type = 'Market'
    UNION ALL
    SELECT data->>'market', 'SPOT', data->>'quoteMint', NULL, 1, '["Spot"]'::jsonb,
           NULL, NULL, data->>'authority', commitment, slot
      FROM indexed_accounts
     WHERE account_type = 'SharedBook' AND data->'kind' ? 'spot'
) m
ORDER BY m.market, (m.commitment = 'confirmed') DESC, m.slot DESC;

-- What one contract of each outcome paid at resolution. Binary invalid pays
-- half to each side; multi-outcome invalid pays 1/N. The program enforces
-- that these divisions are exact.
CREATE VIEW market_outcome_payouts AS
SELECT a.market, o.outcome::text AS outcome,
       CASE
         WHEN a.final_outcome ? 'invalid' THEN div(a.payout, a.outcome_count)
         WHEN a.kind = 'BINARY' THEN
           CASE WHEN (a.final_outcome ? 'yes' AND o.outcome = 0)
                  OR (a.final_outcome ? 'no' AND o.outcome = 1)
                THEN a.payout ELSE 0 END
         ELSE
           CASE WHEN (a.final_outcome->'winner'->0->>0)::int = o.outcome
                THEN a.payout ELSE 0 END
       END AS payout,
       a.final_outcome ? 'invalid' AS invalid
  FROM market_assets a
 CROSS JOIN LATERAL generate_series(0, a.outcome_count - 1) AS o(outcome)
 WHERE a.kind IN ('BINARY', 'MULTI')
   AND a.status ? 'resolved'
   AND jsonb_typeof(a.final_outcome) = 'object';

-- Each fill as per-wallet legs: contracts gained (+) or given (-) and cash
-- received (+) or paid (-), fees included. A normal fill has a taker and a
-- maker on opposite sides. In a complementary fill both parties trade the
-- same direction: binary rows mark the maker leg with ':maker'; multi-outcome
-- fills mark the taker leg with the default address as its maker.
CREATE VIEW trade_legs AS
WITH classified AS (
    SELECT t.*,
           CASE
             WHEN t.engine IN ('SHARED_BINARY', 'LEGACY_BINARY')
                  AND t.execution_id LIKE '%:maker' THEN 'complement_maker'
             WHEN t.engine IN ('SHARED_BINARY', 'LEGACY_BINARY')
                  AND EXISTS (SELECT 1 FROM indexed_trades c
                               WHERE c.execution_id = t.execution_id || ':maker')
                  THEN 'complement_taker'
             WHEN t.engine = 'MULTI_OUTCOME'
                  AND t.maker = '11111111111111111111111111111111' THEN 'complement_taker'
             WHEN t.engine = 'MULTI_OUTCOME'
                  AND EXISTS (SELECT 1 FROM indexed_trades c
                               WHERE c.signature = t.signature AND c.market = t.market
                                 AND c.engine = 'MULTI_OUTCOME'
                                 AND c.maker = '11111111111111111111111111111111')
                  THEN 'complement_maker'
             ELSE 'fill'
           END AS kind
      FROM indexed_trades t
)
SELECT execution_id, signature, slot, transaction_index, execution_index, block_time,
       market, engine, outcome, kind, taker AS wallet, 'taker' AS role,
       maker AS counterparty, price, quantity,
       CASE WHEN taker_side = 'bid' THEN quantity ELSE -quantity END AS contracts,
       CASE WHEN taker_side = 'bid' THEN -quote_atoms ELSE quote_atoms END - fee_atoms AS cash,
       quote_atoms AS volume, fee_atoms AS fee
  FROM classified WHERE kind IN ('fill', 'complement_taker')
UNION ALL
SELECT execution_id, signature, slot, transaction_index, execution_index, block_time,
       market, engine, outcome, kind, maker, 'maker', taker, price, quantity,
       CASE WHEN (kind = 'complement_maker') = (taker_side = 'bid')
            THEN quantity ELSE -quantity END,
       CASE WHEN (kind = 'complement_maker') = (taker_side = 'bid')
            THEN -quote_atoms ELSE quote_atoms END,
       quote_atoms, 0
  FROM classified WHERE kind IN ('fill', 'complement_maker');

-- Splitting collateral into one contract of every outcome, or merging back.
-- The cash moves once per set, so it is carried on the outcome-0 row.
CREATE VIEW complete_set_legs AS
SELECT i.signature, i.execution_index, t.slot, t.transaction_index, t.block_time,
       i.accounts->>'owner' AS wallet, i.accounts->>'market' AS market,
       o.outcome::text AS outcome,
       CASE WHEN (i.arguments->>'split')::boolean THEN q.quantity ELSE -q.quantity END AS contracts,
       CASE WHEN o.outcome <> 0 THEN 0
            WHEN (i.arguments->>'split')::boolean THEN -q.quantity * a.payout
            ELSE q.quantity * a.payout END AS cash
  FROM decoded_instructions i
  JOIN chain_transactions t USING (signature)
  JOIN market_assets a ON a.market = i.accounts->>'market'
 CROSS JOIN LATERAL (SELECT (i.arguments->>'quantity')::numeric AS quantity) q
 CROSS JOIN LATERAL generate_series(0, a.outcome_count - 1) AS o(outcome)
 WHERE i.instruction_name IN ('shared_complete_set', 'multi_outcome_complete_set', 'club_complete_set')
   AND a.kind IN ('BINARY', 'MULTI');

-- Every change to a wallet's prediction contracts and cash, per outcome.
CREATE VIEW position_legs AS
SELECT wallet, market, outcome, contracts, cash, block_time, slot
  FROM trade_legs WHERE engine IN ('SHARED_BINARY', 'LEGACY_BINARY', 'MULTI_OUTCOME')
UNION ALL
SELECT wallet, market, outcome, contracts, cash, block_time, slot FROM complete_set_legs;

-- Realized result per wallet and resolved market: cash flows plus the value
-- of the contracts held at resolution. Redemption only converts that value to
-- cash, so it needs no separate accounting.
CREATE VIEW resolved_market_results AS
SELECT p.wallet, p.market, a.mint,
       SUM(p.cash) + SUM(p.contracts * mp.payout) AS profit,
       SUM(CASE WHEN p.cash < 0 THEN -p.cash ELSE 0 END) AS invested
  FROM position_legs p
  JOIN market_outcome_payouts mp ON mp.market = p.market AND mp.outcome = p.outcome
  JOIN market_assets a ON a.market = p.market
 GROUP BY p.wallet, p.market, a.mint;
