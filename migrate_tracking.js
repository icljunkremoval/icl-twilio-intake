const Database = require("better-sqlite3");
const DB_PATH = process.env.DB_PATH || "/Users/icl-agent/secrets/icl_intake.sqlite";
const db = new Database(DB_PATH);

const migrations = [
  "ALTER TABLE leads ADD COLUMN customer_load_bucket TEXT",
  "ALTER TABLE leads ADD COLUMN customer_access_level TEXT",
  "ALTER TABLE leads ADD COLUMN vision_load_bucket TEXT",
  "ALTER TABLE leads ADD COLUMN vision_access_level TEXT",
  "ALTER TABLE leads ADD COLUMN actual_load_bucket TEXT",
  "ALTER TABLE leads ADD COLUMN last_seen_at TEXT",
];

for (const sql of migrations) {
  try {
    db.prepare(sql).run();
    console.log("OK:", sql);
  } catch (e) {
    if (e.message.includes("duplicate column")) {
      console.log("SKIP:", sql);
    } else {
      console.error("ERROR:", e.message);
    }
  }
}

console.log("Done.");
db.close();
