const { db, insertEvent } = require("./db");
const { priceQuoteV1 } = require("./pricing_v1");
const { createSquarePaymentLink } = require("./square_quote");
const { sendSms } = require("./twilio_sms");

function buildQuoteSms(lead, pricing, paymentUrl) {
  const bucket = pricing.bucket;
  const total = (pricing.total_cents / 100).toFixed(0);
  const deposit = 50;

  return [
    "Your ICL Junk Removal quote is ready.",
    "",
    "Load: " + bucket + "  |  Total: $" + total,
    "",
    "To lock your spot, place a $" + deposit + " deposit here:",
    paymentUrl,
    "",
    "After deposit, you pick your arrival window: 9-11, 12-2, or 3-5."
  ].join("\n");
}

function getLead(from_phone) {
  return db.prepare("SELECT * FROM leads WHERE from_phone = ?").get(from_phone);
}

function claimForQuoting(from_phone) {
  const info = db.prepare(`
    UPDATE leads
    SET quote_status = 'QUOTING',
        last_error = NULL,
        last_seen_at = NOW()
    WHERE from_phone = ?
      AND quote_ready = 1
      AND (quote_status IS NULL OR quote_status = '' OR quote_status = 'READY' OR quote_status = 'ERROR')
  `).run(from_phone);
  return info.changes === 1;
}

function setError(from_phone, err) {
  db.prepare(`
    UPDATE leads
    SET quote_status = 'ERROR',
        last_error = ?,
        last_seen_at = NOW()
    WHERE from_phone = ?
  `).run(String(err && err.message ? err.message : err), from_phone);

  try {
    insertEvent.run({
      from_phone,
      event_type: "quote_error",
      payload_json: JSON.stringify({ from_phone, error: String(err && err.message ? err.message : err) }),
      created_at: new Date().toISOString(),
    });
  } catch (e) {}
}

function writePricing(from_phone, pricing) {
  db.prepare(`
    UPDATE leads
    SET quote_total_cents = ?,
        last_seen_at = NOW()
    WHERE from_phone = ?
  `).run(pricing.total_cents, from_phone);

  try {
    insertEvent.run({
      from_phone,
      event_type: "pricing_v1",
      payload_json: JSON.stringify(pricing),
      created_at: new Date().toISOString(),
    });
  } catch (e) {}
}

async function maybeCreateQuote(from_phone) {
  const lead0 = getLead(from_phone);
  if (!lead0) return { ok: false, reason: "no_lead" };

  if (!claimForQuoting(from_phone)) {
    return { ok: true, changed: false, reason: "not_claimed" };
  }

  try {
    const lead = getLead(from_phone);

    const pricing = priceQuoteV1({
      load_bucket: lead.load_bucket,
      distance_miles: lead.distance_miles || 0,
      access_level: lead.access_level,
    });

    writePricing(from_phone, pricing);

    const square = await createSquarePaymentLink(lead, pricing.total_cents);

    db.prepare(`
      UPDATE leads
      SET square_payment_link_id = ?,
          square_payment_link_url = ?,
          square_order_id = ?,
          quote_status = 'AWAITING_DEPOSIT',
          last_seen_at = NOW()
      WHERE from_phone = ?
    `).run(
      square.payment_link_id,
      square.payment_link_url,
      square.order_id,
      from_phone
    );

    try {
      insertEvent.run({
        from_phone,
        event_type: "square_quote_created",
        payload_json: JSON.stringify({ from_phone, ...square, total_cents: pricing.total_cents }),
        created_at: new Date().toISOString(),
      });
    } catch (e) {}

    const smsBody = buildQuoteSms(lead, pricing, square.payment_link_url);
    const sms = await sendSms(from_phone, smsBody);

    try {
      insertEvent.run({
        from_phone,
        event_type: "sms_sent_quote_link",
        payload_json: JSON.stringify({ from_phone, template: "QUOTE_LINK_V1", twilio: sms }),
        created_at: new Date().toISOString(),
      });
    } catch (e) {}

    db.prepare(`
      UPDATE leads
      SET quote_status = 'AWAITING_DEPOSIT',
          last_seen_at = NOW()
      WHERE from_phone = ?
    `).run(from_phone);

    return {
      ok: true,
      changed: true,
      reason: "square_quote_created_and_sms_sent",
      payment_link_url: square.payment_link_url,
      quote_total_cents: pricing.total_cents,
      sms_sid: sms.sid,
      sms_status: sms.status,
    };
  } catch (e) {
    setError(from_phone, e);
    return { ok: false, reason: "error", error: String(e && e.message ? e.message : e) };
  }
}

module.exports = { maybeCreateQuote };
