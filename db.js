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
      square_payment_id TEXT,
      deposit_paid INTEGER DEFAULT 0,
      deposit_paid_at TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_events_from_phone ON events(from_phone);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  `);
  console.log("[db] Postgres tables ready");
}

// Sync-style wrappers to match existing SQLite API
// We use a queue to handle the async nature

class SyncWrapper {
  constructor(queryFn) {
    this._queryFn = queryFn;
  }
  run(params) {
    this._queryFn(params).catch(e => console.error("[db] run error:", e.message));
  }
  get(param) {
    // Returns a promise — callers must await
    return this._queryFn(param);
  }
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

// db.prepare() compatibility shim for inline queries in conversation.js
const db = {
  prepare: (sql) => ({
    run: (...args) => {
      // Convert ? placeholders to $1, $2...
      let i = 0;
      const pgSql = sql.replace(/datetime\('now'\)/gi, 'NOW()').replace(/\?/g, () => `$${++i}`);
      pool.query(pgSql, args).catch(e => console.error("[db] prepare.run error:", e.message, sql));
    },
    get: async (...args) => {
      let i = 0;
      const pgSql = sql.replace(/datetime\('now'\)/gi, 'NOW()').replace(/\?/g, () => `$${++i}`);
      const res = await pool.query(pgSql, args);
      return res.rows[0] || null;
    }
  })
};

// Initialize on startup
initDb().catch(e => {
  console.error("[db] Init failed:", e.message);
  process.exit(1);
});

module.exports = { db, pool, upsertLead, insertEvent, getLead };
