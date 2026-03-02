const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(process.env.HOME || ".", "secrets", "icl_intake.sqlite");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  from_phone TEXT PRIMARY KEY,
  to_phone   TEXT,
  first_seen_at TEXT,
  last_seen_at  TEXT,

  last_event TEXT,
  last_body  TEXT,
  num_media  INTEGER,
  media_url0 TEXT,

  address_text TEXT,
  zip_text     TEXT,
  distance_miles REAL,

  jobber_client_id TEXT,
  jobber_property_id TEXT,
  jobber_request_id TEXT,
  jobber_quote_id TEXT,
  jobber_clienthub_uri TEXT,

  status TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_phone TEXT,
  event_type TEXT,
  payload_json TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_from_phone ON events(from_phone);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
`);

const upsertLead = db.prepare(`
INSERT INTO leads (
  from_phone, to_phone, first_seen_at, last_seen_at,
  last_event, last_body, num_media, media_url0,
  address_text, zip_text, distance_miles,
  status
) VALUES (
  @from_phone, @to_phone, @ts, @ts,
  @last_event, @last_body, @num_media, @media_url0,
  @address_text, @zip_text, @distance_miles,
  @status
)
ON CONFLICT(from_phone) DO UPDATE SET
  to_phone=excluded.to_phone,
  last_seen_at=excluded.last_seen_at,
  last_event=COALESCE(excluded.last_event, leads.last_event),
  last_body=COALESCE(excluded.last_body, leads.last_body),
  num_media=COALESCE(excluded.num_media, leads.num_media),
  media_url0=COALESCE(excluded.media_url0, leads.media_url0),
  address_text=COALESCE(excluded.address_text, leads.address_text),
  zip_text=COALESCE(excluded.zip_text, leads.zip_text),
  distance_miles=COALESCE(excluded.distance_miles, leads.distance_miles),
  status=COALESCE(excluded.status, leads.status)
`);

const insertEvent = db.prepare(`
INSERT INTO events (from_phone, event_type, payload_json, created_at)
VALUES (@from_phone, @event_type, @payload_json, @created_at)
`);

const getLead = db.prepare(`SELECT * FROM leads WHERE from_phone = ?`);

module.exports = { db, DB_PATH, upsertLead, insertEvent, getLead };
