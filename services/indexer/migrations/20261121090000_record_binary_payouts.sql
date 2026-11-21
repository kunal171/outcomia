-- Complementary YES/NO fills price the taker at payout minus the maker price,
-- so instruction replay needs each binary market's payout per contract.
ALTER TABLE execution_market_info
    ADD COLUMN payout_per_contract NUMERIC(20,0)
    CHECK(payout_per_contract IS NULL OR payout_per_contract>0);

-- Rebuild instruction-derived projections once so markets already replayed
-- record their payout. Same reset the replay worker performs for late history;
-- event-derived fills (multi-outcome) are untouched.
DELETE FROM indexed_trades WHERE engine IN ('SHARED_SPOT','SHARED_BINARY','LEGACY_BINARY');
DELETE FROM execution_orders;
DELETE FROM execution_market_info;
UPDATE decoded_instructions SET replayed=FALSE WHERE replayed;
UPDATE execution_replay_state
    SET slot=0,transaction_index=-1,execution_index=-1,fee_bps=0,fee_known=FALSE,ready=FALSE,last_error=NULL
    WHERE singleton;
