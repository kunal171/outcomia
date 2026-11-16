-- Classic SPL mint precision is immutable. This is not a live supply projection.
CREATE TABLE mint_cache (
    address TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    raw_base64 TEXT NOT NULL,
    decimals SMALLINT NOT NULL CHECK(decimals BETWEEN 0 AND 255),
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
