ALTER TABLE traffic_counters ADD COLUMN last_event_id TEXT;
ALTER TABLE traffic_counters ADD COLUMN last_delta_bytes INTEGER NOT NULL DEFAULT 0 CHECK(last_delta_bytes >= 0);
ALTER TABLE traffic_counters ADD COLUMN last_billed_bytes INTEGER NOT NULL DEFAULT 0 CONSTRAINT traffic_billed_safe_integer CHECK(last_billed_bytes BETWEEN 0 AND 9007199254740991);
