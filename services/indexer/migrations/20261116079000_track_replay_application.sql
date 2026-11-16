-- An older source arriving after the replay cursor must rebuild dependent state.
ALTER TABLE decoded_instructions ADD COLUMN replayed BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX decoded_instructions_unapplied ON decoded_instructions(signature) WHERE NOT replayed;

-- History freshness is separate from current account and chart-worker freshness.
CREATE TABLE history_sync (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
    ready BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO history_sync(singleton) VALUES(TRUE);
