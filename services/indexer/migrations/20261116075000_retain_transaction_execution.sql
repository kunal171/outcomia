CREATE TABLE transaction_execution (
    signature TEXT PRIMARY KEY REFERENCES chain_transactions(signature),
    body JSONB NOT NULL
);
CREATE TABLE decoded_instructions (
    signature TEXT NOT NULL REFERENCES transaction_execution(signature),
    execution_index INTEGER NOT NULL,
    instruction_name TEXT NOT NULL,
    arguments JSONB NOT NULL,
    accounts JSONB NOT NULL,
    PRIMARY KEY(signature,execution_index)
);
CREATE TABLE execution_orders (
    address TEXT PRIMARY KEY,
    market TEXT NOT NULL,
    engine TEXT NOT NULL,
    outcome TEXT NOT NULL,
    owner TEXT NOT NULL,
    side TEXT NOT NULL,
    price NUMERIC(20,0) NOT NULL,
    remaining NUMERIC(20,0) NOT NULL
);
CREATE TABLE execution_replay_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    slot BIGINT NOT NULL DEFAULT 0,
    transaction_index INTEGER NOT NULL DEFAULT -1,
    execution_index INTEGER NOT NULL DEFAULT -1,
    fee_bps SMALLINT NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO execution_replay_state(singleton) VALUES(TRUE);
