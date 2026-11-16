-- Chain discovery identifies a public wallet, never an authenticated web session.
ALTER TABLE users ALTER COLUMN last_login_at DROP NOT NULL;
ALTER TABLE users ALTER COLUMN last_login_at DROP DEFAULT;
ALTER TABLE users ADD COLUMN verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN first_observed_slot BIGINT CHECK(first_observed_slot>=0);
ALTER TABLE users ADD COLUMN registration_source TEXT NOT NULL DEFAULT 'signature'
    CHECK(registration_source IN ('signature','chain'));
UPDATE users SET verified_at=last_login_at;
CREATE INDEX registry_instruction_owner ON decoded_instructions((accounts->>'owner'))
    WHERE instruction_name IN ('deposit','deposit_asset','deposit_prediction_collateral',
        'initialize_asset_balance','initialize_trader_balance','initialize_prediction_position');

-- Older event-only history stores Pubkeys as byte arrays; normalize them once.
CREATE TABLE wallet_registration_events (
    signature TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    PRIMARY KEY(signature,log_index),
    FOREIGN KEY(signature,log_index) REFERENCES chain_events(signature,log_index) ON DELETE CASCADE
);
