ALTER TABLE usage_events ADD COLUMN applied_at TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_events_pending ON usage_events(applied_at, occurred_at);
