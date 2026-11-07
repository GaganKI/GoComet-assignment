CREATE TABLE IF NOT EXISTS rfqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  bid_start TEXT NOT NULL,            -- ISO UTC
  original_close TEXT NOT NULL,       -- close time as first configured
  bid_close TEXT NOT NULL,            -- current (possibly extended) close
  forced_close TEXT NOT NULL,         -- hard limit
  pickup_date TEXT NOT NULL,
  trigger_window_min INTEGER NOT NULL CHECK (trigger_window_min > 0),   -- X
  extension_min INTEGER NOT NULL CHECK (extension_min > 0),             -- Y
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('BID_RECEIVED','ANY_RANK_CHANGE','L1_CHANGE')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (forced_close > original_close),
  CHECK (bid_close >= original_close AND bid_close <= forced_close)
);
CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_id INTEGER NOT NULL REFERENCES rfqs(id),
  carrier TEXT NOT NULL,
  freight REAL NOT NULL, origin_charges REAL NOT NULL, destination_charges REAL NOT NULL,
  total REAL NOT NULL,
  transit_days INTEGER NOT NULL,
  quote_validity TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bids_rfq ON bids(rfq_id, carrier, id);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_id INTEGER NOT NULL REFERENCES rfqs(id),
  type TEXT NOT NULL CHECK (type IN ('BID','EXTENSION','RFQ_CREATED')),
  message TEXT NOT NULL,
  old_close TEXT, new_close TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_rfq ON activity_log(rfq_id, id);
