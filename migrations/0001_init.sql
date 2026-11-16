PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_records (
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  document TEXT NOT NULL CHECK (json_valid(document)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (collection, record_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_app_records_collection_updated ON app_records(collection, updated_at DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  event_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  inbound_id TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes >= 0),
  billed_bytes INTEGER NOT NULL CHECK(billed_bytes >= 0),
  multiplier REAL NOT NULL CHECK(multiplier >= 0),
  occurred_at TEXT NOT NULL,
  usage_day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_user_day ON usage_events(user_id, usage_day);
CREATE INDEX IF NOT EXISTS idx_usage_events_node_day ON usage_events(node_id, usage_day);

CREATE TABLE IF NOT EXISTS traffic_counters (
  counter_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  inbound_id TEXT NOT NULL,
  client_key TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  last_total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(last_total_bytes >= 0),
  last_sampled_at TEXT NOT NULL,
  multiplier REAL NOT NULL DEFAULT 1 CHECK(multiplier >= 0),
  UNIQUE(node_id, inbound_id, client_key, epoch)
);
CREATE INDEX IF NOT EXISTS idx_traffic_counters_node ON traffic_counters(node_id, inbound_id);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(provider, event_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS job_leases (
  job_name TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  cursor TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(status, available_at);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  order_id TEXT,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ledger_user_created ON ledger_entries(user_id, created_at DESC);
