const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      from_phone TEXT PRIMARY KEY,
      to_phone TEXT,
      first_seen_at TEXT,
      last_seen_at TEXT,
      last_event TEXT,
      last_body TEXT,
      num_media INTEGER,
      media_url0 TEXT,
      address_text TEXT,
      zip_text TEXT,
      zip TEXT,
      distance_miles REAL,
      geo_lat DOUBLE PRECISION,
      geo_lng DOUBLE PRECISION,
      geocoded_at TEXT,
      geo_source TEXT,
      has_media INTEGER DEFAULT 0,
      conv_state TEXT DEFAULT 'NEW',
      quote_status TEXT,
      quote_ready INTEGER DEFAULT 0,
      low_confidence_retry INTEGER DEFAULT 0,
      job_scope TEXT,
      rentcast_sqft INTEGER,
      soft_flag INTEGER DEFAULT 0,
      escalation_reason TEXT,
      load_bucket TEXT,
      access_level TEXT,
      timing_pref TEXT,
      hazmat INTEGER DEFAULT 0,
      square_payment_link_id TEXT,
      square_payment_link_url TEXT,
      square_order_id TEXT,
      square_upfront_payment_link_id TEXT,
      square_upfront_payment_link_url TEXT,
      square_upfront_order_id TEXT,
      square_payment_id TEXT,
      deposit_paid INTEGER DEFAULT 0,
      deposit_paid_at TEXT,
      quote_total_cents INTEGER,
      upfront_total_cents INTEGER,
      upfront_discount_pct REAL,
      troll_flag INTEGER DEFAULT 0,
      vision_analysis TEXT,
      crew_notes TEXT,
      item_tags TEXT,
      customer_load_bucket TEXT,
      customer_access_level TEXT,
      vision_load_bucket TEXT,
      vision_access_level TEXT,
      actual_load_bucket TEXT,
      last_error TEXT,
      status TEXT,
      settled_revenue_cents INTEGER,
      square_settled_at TEXT,
      labor_cost_cents INTEGER,
      disposal_cost_cents INTEGER,
      fuel_cost_cents INTEGER,
      other_cost_cents INTEGER,
      total_cost_cents INTEGER,
      margin_cents INTEGER,
      margin_pct REAL,
      margin_refreshed_at TEXT,
      next_action_sent_at TEXT,
      next_action_sent_count INTEGER DEFAULT 0,
      next_action_last_kind TEXT,
      next_action_last_error TEXT,
      archived_at TEXT,
      archived_reason TEXT,
      lead_source TEXT DEFAULT 'sms',
      referral_partner TEXT,
      referral_agent_name TEXT,
      referral_notified_at TEXT,
      referral_payout_cents INTEGER DEFAULT 0,
      referral_payout_sent_at TEXT,
      prelisting_addons TEXT,
      prelisting_addon_total_cents INTEGER DEFAULT 0,
      aerial_media_requested INTEGER DEFAULT 0,
      aerial_media_delivered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      from_phone TEXT,
      event_type TEXT,
      payload_json TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS dashboard_state (
      state_key TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dumpsite_overrides (
      site_id TEXT PRIMARY KEY,
      override_state TEXT NOT NULL,
      reason TEXT,
      active_until TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_from_phone ON events(from_phone);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  `);

  // Run migrations for any missing columns
  const migrations = [
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS stall_count INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS dropoff_alerted_at TIMESTAMPTZ",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_error TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS zip TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS geo_lat DOUBLE PRECISION",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS geo_lng DOUBLE PRECISION",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS geocoded_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS geo_source TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_load_bucket TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_access_level TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS vision_load_bucket TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS vision_access_level TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS actual_load_bucket TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS dropoff_alerted_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS salvage_items TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS salvage_est_value INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS salvage_actual_value INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS salvage_posted_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS diversion_donated_items TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS diversion_scrap_items TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS diversion_dump_weight_lbs INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS diversion_rate REAL",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS junk_fee_actual INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS square_payment_link_id TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS square_payment_link_url TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS square_order_id TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS square_upfront_payment_link_id TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS square_upfront_payment_link_url TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS square_upfront_order_id TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS square_payment_id TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS deposit_paid INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS deposit_paid_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS quote_total_cents INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS upfront_total_cents INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS upfront_discount_pct REAL",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS troll_flag INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS vision_analysis TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS crew_notes TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS item_tags TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS timing_pref TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS hazmat INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS has_media INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS conv_state TEXT DEFAULT 'NEW'",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS quote_status TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS quote_ready INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS low_confidence_retry INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS job_scope TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS rentcast_sqft INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS soft_flag INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS escalation_reason TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS load_bucket TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS access_level TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS settled_revenue_cents INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS square_settled_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS labor_cost_cents INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS disposal_cost_cents INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS fuel_cost_cents INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS other_cost_cents INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS total_cost_cents INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS margin_cents INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS margin_pct REAL",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS margin_refreshed_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_action_sent_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_action_sent_count INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_action_last_kind TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_action_last_error TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS archived_reason TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_source TEXT DEFAULT 'sms'",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_partner TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_agent_name TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_notified_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_payout_cents INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_payout_sent_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS prelisting_addons TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS prelisting_addon_total_cents INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS aerial_media_requested INTEGER DEFAULT 0",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS aerial_media_delivered_at TEXT"
  ];

  for (const sql of migrations) {
    try { await pool.query(sql); } catch(e) {}
  }

  console.log("[db] Postgres ready");
}

const upsertLead = {
  run: (params) => {
    const sql = `
      INSERT INTO leads (
        from_phone, to_phone, first_seen_at, last_seen_at,
        last_event, last_body, num_media, media_url0,
        address_text, zip_text, zip, distance_miles, status
      ) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT(from_phone) DO UPDATE SET
        to_phone = EXCLUDED.to_phone,
        last_seen_at = EXCLUDED.last_seen_at,
        last_event = COALESCE(EXCLUDED.last_event, leads.last_event),
        last_body = COALESCE(EXCLUDED.last_body, leads.last_body),
        num_media = COALESCE(EXCLUDED.num_media, leads.num_media),
        media_url0 = COALESCE(EXCLUDED.media_url0, leads.media_url0),
        address_text = COALESCE(EXCLUDED.address_text, leads.address_text),
        zip_text = COALESCE(EXCLUDED.zip_text, leads.zip_text),
        zip = COALESCE(EXCLUDED.zip, leads.zip),
        distance_miles = COALESCE(EXCLUDED.distance_miles, leads.distance_miles),
        status = COALESCE(EXCLUDED.status, leads.status)
    `;
    pool.query(sql, [
      params.from_phone, params.to_phone, params.ts,
      params.last_event || null, params.last_body || null,
      params.num_media || 0, params.media_url0 || null,
      params.address_text || null, params.zip_text || null,
      params.zip || null, params.distance_miles || null,
      params.status || null
    ]).catch(e => console.error("[db] upsertLead error:", e.message));
  }
};

const insertEvent = {
  run: (params) => {
    pool.query(
      `INSERT INTO events (from_phone, event_type, payload_json, created_at) VALUES ($1,$2,$3,$4)`,
      [params.from_phone, params.event_type, params.payload_json, params.created_at]
    ).catch(e => console.error("[db] insertEvent error:", e.message));
  }
};

const getLead = {
  get: async (from_phone) => {
    const res = await pool.query(`SELECT * FROM leads WHERE from_phone = $1`, [from_phone]);
    return res.rows[0] || null;
  }
};

const db = {
  prepare: (sql) => ({
    run: (...args) => {
      let i = 0;
      const pgSql = sql
        .replace(/datetime\('now'\)/gi, "NOW()")
        .replace(/\?/g, () => `$${++i}`);
      pool.query(pgSql, args).catch(e => console.error("[db] prepare.run error:", e.message));
    },
    get: async (...args) => {
      let i = 0;
      const pgSql = sql
        .replace(/datetime\('now'\)/gi, "NOW()")
        .replace(/\?/g, () => `$${++i}`);
      const res = await pool.query(pgSql, args);
      return res.rows[0] || null;
    }
  })
};

initDb().catch(e => {
  console.error("[db] Init failed:", e.message);
  process.exit(1);
});

module.exports = { db, pool, upsertLead, insertEvent, getLead };
