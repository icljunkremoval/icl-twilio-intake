const { db, insertEvent } = require("./db");
const { evaluateQuoteReadyRow } = require("./quote_gate");

function maybeFlipQuoteReady(from_phone) {
  const row = db.prepare("SELECT * FROM leads WHERE from_phone = ?").get(from_phone);
  if (!row) return { ok: false, reason: "no_lead" };

  // If already flipped, no-op
  if (Number(row.quote_ready) === 1 || String(row.quote_status || "").toUpperCase() === "READY") {
    return { ok: true, changed: false, reason: "already_ready" };
  }

  const ready = evaluateQuoteReadyRow(row);
  if (!ready) return { ok: true, changed: false, reason: "not_ready" };

  // Flip exactly once
  db.prepare(
    "UPDATE leads SET quote_ready = 1, quote_status = 'READY', last_seen_at = NOW() WHERE from_phone = ?"
  ).run(from_phone);

  try {
    insertEvent.run({
      from_phone,
      event_type: "quote_ready",
      payload_json: JSON.stringify({ from_phone, quote_status: "READY" }),
      created_at: new Date().toISOString(),
    });
  } catch {}

  return { ok: true, changed: true, reason: "flipped_ready" };
}

module.exports = { maybeFlipQuoteReady };
