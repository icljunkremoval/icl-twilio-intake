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
      has_media INTEGER DEFAULT 0,
      conv_state TEXT DEFAULT 'NEW',
      quote_status TEXT,
      quote_ready INTEGER DEFAULT 0,
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
      calendar_event_id TEXT,
      calendar_event_url TEXT,
      calendar_sync_status TEXT,
      calendar_synced_at TEXT,
      lead_name TEXT,
      lead_email TEXT,
      notes TEXT,
      quoted_amount INTEGER,
      site_visit_date TEXT,
      lead_source TEXT DEFAULT 'sms',
      item_list TEXT,
      media_urls TEXT,
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
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      from_phone TEXT,
      event_type TEXT,
      payload_json TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS job_items (
      id SERIAL PRIMARY KEY,
      job_id TEXT,
      from_phone TEXT,
      item_name TEXT NOT NULL,
      bucket TEXT NOT NULL,
      est_value_low INTEGER,
      est_value_high INTEGER,
      confidence REAL,
      platform TEXT,
      crew_notes TEXT,
      status TEXT,
      source TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS buyers (
      buyer_id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      categories TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      last_contacted TEXT
    );

    CREATE TABLE IF NOT EXISTS job_financials (
      id SERIAL PRIMARY KEY,
      job_id TEXT NOT NULL,
      from_phone TEXT,
      removal_fee INTEGER,
      scrap_revenue INTEGER,
      resale_revenue INTEGER,
      donation_count INTEGER,
      total_yield INTEGER,
      zip_code TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_from_phone ON events(from_phone);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_job_items_phone ON job_items(from_phone);
    CREATE INDEX IF NOT EXISTS idx_job_items_job_id ON job_items(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_items_bucket ON job_items(bucket);
    CREATE INDEX IF NOT EXISTS idx_job_financials_phone ON job_financials(from_phone);
  `);

  // Run migrations for any missing columns
  const migrations = [
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_error TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS zip TEXT",
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
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS calendar_event_id TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS calendar_event_url TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS calendar_sync_status TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS calendar_synced_at TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_name TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_email TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS quoted_amount INTEGER",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS site_visit_date TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_source TEXT DEFAULT 'sms'",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS item_list TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS media_urls TEXT",
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
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS load_bucket TEXT",
    "ALTER TABLE leads ADD COLUMN IF NOT EXISTS access_level TEXT"
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
