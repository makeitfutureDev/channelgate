// Request identities and arrival order survive producer reconnects and daemon restarts.
export const threadTurnMigration = `
  CREATE TABLE thread_turn_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_ms INTEGER NOT NULL,
    UNIQUE(owner_key, request_id)
  );
  CREATE INDEX idx_thread_turn_receipts_age ON thread_turn_receipts(updated_ms);
  CREATE TABLE thread_stop_targets (
    owner_key TEXT NOT NULL,
    actor TEXT NOT NULL,
    event_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    PRIMARY KEY(owner_key, actor, event_id)
  );
  CREATE INDEX idx_thread_stop_targets_age ON thread_stop_targets(created_ms);
`;
