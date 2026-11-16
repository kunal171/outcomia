ALTER TABLE login_challenges ADD COLUMN domain TEXT NOT NULL DEFAULT '';
CREATE INDEX login_challenges_rate ON login_challenges(created_at,wallet_address);
