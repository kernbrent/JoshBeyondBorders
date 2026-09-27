PRAGMA foreign_keys = ON;

ALTER TABLE donors ADD COLUMN preferred_name TEXT;
ALTER TABLE donors ADD COLUMN organization TEXT;
ALTER TABLE donors ADD COLUMN website TEXT;
ALTER TABLE donors ADD COLUMN notes TEXT;
ALTER TABLE donors ADD COLUMN phone_normalized TEXT;
ALTER TABLE donors ADD COLUMN contact_preference TEXT NOT NULL DEFAULT 'email'
  CHECK (contact_preference IN ('email', 'phone'));
ALTER TABLE donors ADD COLUMN contact_status TEXT NOT NULL DEFAULT 'active'
  CHECK (contact_status IN ('active', 'inactive'));
ALTER TABLE donors ADD COLUMN last_contacted_at TEXT;
ALTER TABLE donors ADD COLUMN last_contacted_note TEXT
  CHECK (last_contacted_note IS NULL OR length(last_contacted_note) <= 50);

UPDATE donors
SET phone_normalized = NULLIF(
  replace(replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''),
  ''
)
WHERE phone IS NOT NULL;

UPDATE donors
SET contact_preference = 'phone'
WHERE email IS NULL AND phone IS NOT NULL;

CREATE INDEX donors_status_name_idx
  ON donors (contact_status, display_name COLLATE NOCASE);
CREATE INDEX donors_phone_idx
  ON donors (phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX donors_last_contacted_idx
  ON donors (last_contacted_at DESC) WHERE last_contacted_at IS NOT NULL;

CREATE TABLE donor_contact_types (
  donor_id TEXT NOT NULL REFERENCES donors(id) ON DELETE CASCADE,
  contact_type TEXT NOT NULL CHECK (contact_type IN (
    'donor', 'supporter', 'prayer_partner', 'ministry_contact',
    'venue_contact', 'musician', 'volunteer', 'other'
  )),
  created_at TEXT NOT NULL,
  PRIMARY KEY (donor_id, contact_type)
);

CREATE INDEX donor_contact_types_type_idx
  ON donor_contact_types (contact_type, donor_id);

INSERT INTO donor_contact_types (donor_id, contact_type, created_at)
SELECT id, 'donor', created_at FROM donors;

PRAGMA optimize;
