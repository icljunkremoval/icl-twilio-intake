const { pool, insertEvent } = require("./db");
const { evaluateQuoteReadyRow } = require("./quote_gate");

async function maybeFlipQuoteReady(from_phone) {
  const res = await pool.query("SELECT * FROM leads WHERE from_phone = $1", [from_phone]);
  const row = res.rows[0] || null;
  if (!row) return { ok: false, reason: "no_lead" };

  if (Number(row.quote_ready) === 1 || String(row.quote_status || "").toUpperCase() === "READY") {
    return { ok: true, changed: false, reason: "already_ready" };
  }

  const ready = evaluateQuoteReadyRow(row);
  if (!ready) return { ok: true, changed: false, reason: "not_ready" };

  await pool.query(
    "UPDATE leads SET quote_ready = 1, quote_status = 'READY', last_seen_at = NOW() WHERE from_phone = $1",
    [from_phone]
  );

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
