CREATE TABLE indexed_trades (
    execution_id TEXT PRIMARY KEY,
    signature TEXT NOT NULL REFERENCES chain_transactions(signature),
    slot BIGINT NOT NULL CHECK(slot>=0),
    transaction_index INTEGER,
    execution_index INTEGER NOT NULL CHECK(execution_index>=0),
    block_time BIGINT,
    market TEXT NOT NULL,
    engine TEXT NOT NULL,
    outcome TEXT NOT NULL,
    maker TEXT NOT NULL,
    taker TEXT NOT NULL,
    taker_side TEXT NOT NULL CHECK(taker_side IN ('bid','ask')),
    price NUMERIC(20,0) NOT NULL CHECK(price>0),
    quantity NUMERIC(20,0) NOT NULL CHECK(quantity>0),
    quote_atoms NUMERIC(20,0) NOT NULL CHECK(quote_atoms>=0),
    fee_atoms NUMERIC(20,0) NOT NULL CHECK(fee_atoms>=0)
);
CREATE INDEX indexed_trades_market_time ON indexed_trades(market,engine,outcome,block_time,slot,transaction_index,execution_index);
CREATE INDEX indexed_trades_owner ON indexed_trades(maker,taker,slot);
CREATE TABLE trade_projection_checkpoint (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT
);
