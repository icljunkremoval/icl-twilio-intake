const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || "/Users/icl-agent/secrets/icl_intake.sqlite";
const db = new Database(DB_PATH);

const columns = [
  "ALTER TABLE leads ADD COLUMN square_payment_link_id TEXT",
  "ALTER TABLE leads ADD COLUMN square_payment_link_url TEXT",
  "ALTER TABLE leads ADD COLUMN square_order_id TEXT",
];

for (const sql of columns) {
  try {
    db.prepare(sql).run();
    console.log("OK:", sql);
  } catch (e) {
    if (e.message.includes("duplicate column")) {
      console.log("SKIP (exists):", sql);
    } else {
      console.error("ERROR:", e.message);
    }
  }
}

console.log("Migration complete.");
db.close();
