-- Club books (place/match/complement/cancel_club_order) now replay into the
-- shared binary trade history. Rebuild instruction-derived projections once so
-- club instructions already marked replayed are applied. Same reset as the
-- replay worker performs for late history; event-derived fills are untouched.
DELETE FROM indexed_trades WHERE engine IN ('SHARED_SPOT','SHARED_BINARY','LEGACY_BINARY');
DELETE FROM execution_orders;
DELETE FROM execution_market_info;
UPDATE decoded_instructions SET replayed=FALSE WHERE replayed;
UPDATE execution_replay_state
    SET slot=0,transaction_index=-1,execution_index=-1,fee_bps=0,fee_known=FALSE,ready=FALSE,last_error=NULL
    WHERE singleton;
