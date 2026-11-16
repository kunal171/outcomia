CREATE TABLE instruction_decode_state (
    signature TEXT PRIMARY KEY REFERENCES transaction_execution(signature),
    decoded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE execution_replay_state ADD COLUMN fee_known BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE execution_replay_state ADD COLUMN ready BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE execution_market_info (
    market TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    base_decimals SMALLINT NOT NULL
);
