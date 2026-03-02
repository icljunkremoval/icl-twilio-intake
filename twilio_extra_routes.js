const { recomputeDerived } = require("./recompute");
const express = require("express");
const { maybeFlipQuoteReady } = require(".\/quote_orchestrator");
const { maybeCreateQuote } = require("./quote_worker");

function normPhone(v) {
  return String(v || "").trim();
}

module.exports = function mountTwilioExtraRoutes(app, db, insertEvent) {
  // POST /twilio/q_load  { from_phone, load_bucket }
  app.post("/twilio/q_load", (req, res) => {
    const from = normPhone(req.body.from_phone || req.body.From);
    const load_bucket = String(req.body.load_bucket || "").trim().toUpperCase();
    if (!from || !load_bucket) return res.status(400).json({ ok: false, error: "missing_from_or_load" });

    const payload = { event: "q_load", From: from, load_bucket };

    try {
      insertEvent.run({
        from_phone: from,
        event_type: "q_load",
        payload_json: JSON.stringify(payload),
        created_at: new Date().toISOString(),
      });
    } catch {}

    try {
      db.prepare("UPDATE leads SET load_bucket = ?, last_seen_at = datetime(\x27now\x27) WHERE from_phone = ?").run(load_bucket, from);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }

    const gate = maybeFlipQuoteReady(from);
    if (gate && (gate.changed || gate.reason === "already_ready" || gate.reason === "already_ready")) { try { maybeCreateQuote(from); } catch (e) {} }
    try { recomputeDerived(from); } catch (e) {}

    return res.json({ ok: true, gate });
  });

  // POST /twilio/q_access  { from_phone, access_level }
  app.post("/twilio/q_access", (req, res) => {
    const from = normPhone(req.body.from_phone || req.body.From);
    const access_level = String(req.body.access_level || "").trim().toUpperCase();
    if (!from || !access_level) return res.status(400).json({ ok: false, error: "missing_from_or_access" });

    const payload = { event: "q_access", From: from, access_level };

    try {
      insertEvent.run({
        from_phone: from,
        event_type: "q_access",
        payload_json: JSON.stringify(payload),
        created_at: new Date().toISOString(),
      });
    } catch {}

    try {
      db.prepare("UPDATE leads SET access_level = ?, last_seen_at = datetime(\x27now\x27) WHERE from_phone = ?").run(access_level, from);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }

    const gate = maybeFlipQuoteReady(from);
    if (gate && (gate.changed || gate.reason === "already_ready" || gate.reason === "already_ready")) { try { maybeCreateQuote(from); } catch (e) {} }
    try { recomputeDerived(from); } catch (e) {}

    return res.json({ ok: true, gate });
  });

  // POST /twilio/zip_capture  { from_phone, zip }
  app.post("/twilio/zip_capture", (req, res) => {
    const from = normPhone(req.body.from_phone || req.body.From);
    const zip = String(req.body.zip || req.body.Zip || "").trim();
    if (!from || !zip) return res.status(400).json({ ok: false, error: "missing_from_or_zip" });

    const payload = { event: "zip_capture", From: from, Zip: zip, zip };

    try {
      insertEvent.run({
        from_phone: from,
        event_type: "zip_capture",
        payload_json: JSON.stringify(payload),
        created_at: new Date().toISOString(),
      });
    } catch {}

    try {
      db.prepare("UPDATE leads SET zip = ?, zip_text = ?, last_seen_at = datetime(\x27now\x27) WHERE from_phone = ?").run(zip, zip, from);
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }

    const gate = maybeFlipQuoteReady(from);
    if (gate && (gate.changed || gate.reason === "already_ready" || gate.reason === "already_ready")) { try { maybeCreateQuote(from); } catch (e) {} }
    try { recomputeDerived(from); } catch (e) {}

    return res.json({ ok: true, gate });
  });
};
