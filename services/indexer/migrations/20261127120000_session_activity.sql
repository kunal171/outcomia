-- Sessions end after 2 hours without activity and 24 hours at most, and
-- record how they were proven. Existing sessions are Solana sign-ins unless
-- they have no login challenge (Canton claims bind their own).
ALTER TABLE user_sessions
  ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN method TEXT NOT NULL DEFAULT 'solana' CHECK (method IN ('solana','canton'));
UPDATE user_sessions SET expires_at=LEAST(expires_at, NOW()+INTERVAL '24 hours');
