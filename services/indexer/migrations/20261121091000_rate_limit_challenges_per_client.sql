-- Sign-in challenges are limited per client as well as per wallet, so one
-- client cycling wallet addresses cannot exhaust issuance for everyone.
-- Stores only a SHA-256 digest of the client identity (IP address).
ALTER TABLE login_challenges ADD COLUMN client_hash TEXT;
CREATE INDEX login_challenges_client_recent ON login_challenges(client_hash, created_at);
