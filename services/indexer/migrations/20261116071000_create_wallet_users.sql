CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE login_challenges (
    challenge_hash TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    message TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX login_challenges_expiry ON login_challenges(expires_at);
CREATE TABLE user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX user_sessions_expiry ON user_sessions(expires_at);
CREATE TABLE tracked_wallets (
    owner TEXT PRIMARY KEY REFERENCES users(wallet_address),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE wallet_assets (
    commitment TEXT NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
    owner TEXT NOT NULL REFERENCES tracked_wallets(owner),
    mint TEXT NOT NULL,
    token_program TEXT NOT NULL,
    amount NUMERIC(20,0) NOT NULL CHECK (amount >= 0),
    frozen NUMERIC(20,0) NOT NULL CHECK (frozen >= 0),
    decimals SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 255),
    account_count INTEGER NOT NULL CHECK (account_count >= 0),
    slot BIGINT NOT NULL CHECK (slot >= 0),
    PRIMARY KEY(commitment, owner, mint, token_program)
);
CREATE TABLE wallet_sync (
    commitment TEXT NOT NULL,
    owner TEXT NOT NULL REFERENCES tracked_wallets(owner),
    observed_at TIMESTAMPTZ,
    ready BOOLEAN NOT NULL DEFAULT FALSE,
    last_error TEXT,
    PRIMARY KEY(commitment, owner)
);
