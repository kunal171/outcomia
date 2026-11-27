-- One profile for Solana and Canton. A user is the profile identity: it may
-- have a Solana wallet (users.wallet_address), Canton parties, or both.
-- Canton parties are added only after the party proves itself on the ledger.

-- A Canton-only user has no Solana wallet.
ALTER TABLE users ALTER COLUMN wallet_address DROP NOT NULL;

CREATE TABLE canton_accounts (
    network TEXT NOT NULL CHECK (char_length(network) BETWEEN 1 AND 64),
    party TEXT NOT NULL CHECK (char_length(party) BETWEEN 3 AND 300),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A party belongs to at most one user on each network.
    PRIMARY KEY (network, party)
);
CREATE INDEX canton_accounts_user ON canton_accounts(user_id);

-- One-time nonces for ProfileClaim contracts. `user_id` is set for links,
-- which must be finished by the same signed-in user.
CREATE TABLE canton_challenges (
    challenge_hash TEXT PRIMARY KEY,
    network TEXT NOT NULL,
    party TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('signIn', 'link')),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    solana_wallet TEXT,
    client_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    CHECK ((purpose = 'link') = (user_id IS NOT NULL AND solana_wallet IS NOT NULL))
);
CREATE INDEX canton_challenges_expiry ON canton_challenges(expires_at);

-- Profiles are owned by a user rather than a Solana wallet. `wallet` stays as
-- the user's Solana wallet (null for Canton-only users), so leaderboards that
-- join on wallets keep working.
ALTER TABLE profiles ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
UPDATE profiles p SET user_id = u.id FROM users u WHERE u.wallet_address = p.wallet;
ALTER TABLE profiles ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE profiles DROP CONSTRAINT profiles_pkey;
ALTER TABLE profiles ADD PRIMARY KEY (user_id);
ALTER TABLE profiles ALTER COLUMN wallet DROP NOT NULL;
CREATE UNIQUE INDEX profiles_wallet ON profiles(wallet);
