-- One database is bound to one program/network and supported account decoder.
CREATE TABLE indexer_identity (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    genesis_hash TEXT NOT NULL,
    program_id TEXT NOT NULL,
    idl_hash TEXT NOT NULL
);
CREATE TABLE account_sync (
    commitment TEXT PRIMARY KEY CHECK (commitment IN ('confirmed', 'finalized')),
    slot BIGINT NOT NULL DEFAULT 0 CHECK (slot >= 0),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    observed_at TIMESTAMPTZ,
    ready BOOLEAN NOT NULL DEFAULT FALSE,
    last_error TEXT
);
INSERT INTO account_sync(commitment) VALUES ('confirmed'), ('finalized');
CREATE TABLE indexed_accounts (
    commitment TEXT NOT NULL REFERENCES account_sync(commitment),
    address TEXT NOT NULL,
    account_type TEXT NOT NULL,
    data JSONB NOT NULL,
    raw_base64 TEXT NOT NULL,
    lamports NUMERIC(20,0) NOT NULL CHECK (lamports >= 0),
    slot BIGINT NOT NULL CHECK (slot >= 0),
    revision BIGINT NOT NULL CHECK (revision >= 0),
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (commitment, address)
);
CREATE INDEX indexed_accounts_type ON indexed_accounts(commitment, account_type, address) WHERE NOT deleted;
CREATE INDEX indexed_accounts_owner ON indexed_accounts(commitment, (data->>'owner'), account_type, address) WHERE NOT deleted;
CREATE INDEX indexed_accounts_market ON indexed_accounts(commitment, (data->>'market'), account_type, address) WHERE NOT deleted;
CREATE INDEX indexed_accounts_book ON indexed_accounts(commitment, (data->>'book'), account_type, address) WHERE NOT deleted;
