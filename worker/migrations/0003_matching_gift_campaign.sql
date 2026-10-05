PRAGMA foreign_keys = ON;

CREATE TABLE matching_gift_campaigns (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  match_cap REAL NOT NULL CHECK (match_cap > 0),
  match_ratio REAL NOT NULL DEFAULT 1 CHECK (match_ratio > 0),
  item_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (start_at < end_at)
);

CREATE INDEX matching_gift_campaigns_dates_idx
  ON matching_gift_campaigns (status, start_at, end_at);

CREATE TABLE matching_gift_transaction_overrides (
  campaign_id TEXT NOT NULL REFERENCES matching_gift_campaigns(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES financial_transactions(id) ON DELETE CASCADE,
  eligibility TEXT NOT NULL CHECK (eligibility = 'exclude'),
  note TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, transaction_id)
);

CREATE INDEX matching_gift_overrides_transaction_idx
  ON matching_gift_transaction_overrides (transaction_id);

-- October 4 at midnight through the end of October 8 in America/Chicago.
-- These UTC boundaries account for Central Daylight Time in October 2026.
INSERT INTO matching_gift_campaigns
  (id, title, start_at, end_at, match_cap, match_ratio, item_id, status, created_at, updated_at)
VALUES
  ('october-2026-match', 'October Matching Gift',
   '2026-10-04T05:00:00.000Z', '2026-10-09T05:00:00.000Z',
   575, 1, 'BeyondBorders', 'active',
   '2026-10-04T05:00:00.000Z', '2026-10-04T05:00:00.000Z');

PRAGMA optimize;
