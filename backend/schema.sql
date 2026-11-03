CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  alias TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  delete_token_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS campaigns_public_feed
  ON campaigns (status, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  fingerprint TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (fingerprint, window_start)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('suspicious', 'privacy', 'account')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS reports_open_queue
  ON reports (status, created_at ASC);
