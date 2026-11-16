-- Retain the digest after the short-lived challenge is pruned. No FK: sessions
-- outlive challenges, but logout must revoke a concurrently issued credential.
ALTER TABLE user_sessions ADD COLUMN challenge_hash TEXT;
CREATE INDEX user_sessions_challenge ON user_sessions(challenge_hash);
