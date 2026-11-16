CREATE TABLE confirmed_receipts (
    signature TEXT PRIMARY KEY,
    slot BIGINT NOT NULL CHECK(slot>=0),
    failed BOOLEAN NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX confirmed_receipts_observed ON confirmed_receipts(observed_at);
