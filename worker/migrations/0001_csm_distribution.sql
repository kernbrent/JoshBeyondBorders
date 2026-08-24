PRAGMA foreign_keys = ON;

CREATE TABLE donors (
  id TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  email_normalized TEXT,
  phone TEXT,
  address_line_1 TEXT,
  address_line_2 TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  country TEXT,
  source TEXT NOT NULL CHECK (source IN ('workbook', 'csm', 'manual')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX donors_email_idx ON donors (email_normalized);
CREATE INDEX donors_name_idx ON donors (display_name COLLATE NOCASE);

CREATE TABLE csm_distribution_inbox (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  source_record_id TEXT NOT NULL,
  source_transaction_id TEXT NOT NULL,
  source_event_code TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  direction TEXT NOT NULL CHECK (direction IN ('received', 'sent')),
  display_name TEXT NOT NULL,
  master_donor_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'needs_match', 'approved', 'denied', 'failed')),
  matched_donor_id TEXT REFERENCES donors(id) ON DELETE RESTRICT,
  match_method TEXT CHECK (match_method IS NULL OR match_method IN ('master_link', 'email', 'manual', 'new_donor')),
  decision_reason TEXT,
  recipient_record_id TEXT,
  callback_status TEXT NOT NULL DEFAULT 'not_needed' CHECK (callback_status IN ('not_needed', 'pending', 'sent', 'failed')),
  callback_attempts INTEGER NOT NULL DEFAULT 0,
  callback_error TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (source_record_id, source_revision)
);

CREATE INDEX csm_distribution_inbox_status_idx ON csm_distribution_inbox (status, received_at DESC);

CREATE TABLE csm_donor_links (
  master_donor_id TEXT PRIMARY KEY,
  donor_id TEXT NOT NULL REFERENCES donors(id) ON DELETE RESTRICT,
  created_from_inbox_id TEXT NOT NULL REFERENCES csm_distribution_inbox(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX csm_donor_links_donor_idx ON csm_donor_links (donor_id);

CREATE TABLE financial_transactions (
  id TEXT PRIMARY KEY,
  source_inbox_id TEXT NOT NULL UNIQUE REFERENCES csm_distribution_inbox(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL UNIQUE,
  paypal_transaction_id TEXT NOT NULL,
  paypal_event_code TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('received', 'sent')),
  display_name TEXT NOT NULL,
  donor_id TEXT REFERENCES donors(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  gross REAL NOT NULL,
  fee REAL NOT NULL,
  net REAL NOT NULL,
  item_name TEXT,
  item_id TEXT,
  created_at TEXT NOT NULL,
  CHECK ((direction = 'received' AND donor_id IS NOT NULL AND gross > 0) OR (direction = 'sent' AND donor_id IS NULL AND gross < 0)),
  UNIQUE (paypal_transaction_id, paypal_event_code)
);

CREATE INDEX financial_transactions_date_idx ON financial_transactions (transaction_date DESC);
CREATE INDEX financial_transactions_donor_idx ON financial_transactions (donor_id, transaction_date DESC);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, created_at DESC);

PRAGMA optimize;
