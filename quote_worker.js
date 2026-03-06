const { db, pool, insertEvent } = require("./db");
const { priceQuoteV1 } = require("./pricing_v1");
const { createSquarePaymentLink } = require("./square_quote");
const { sendSms } = require("./twilio_sms");

function buildQuoteSms(lead, pricing, paymentUrl) {
  const bucket = pricing.bucket;
  const total = (pricing.total_cents / 100).toFixed(0);
  const deposit = 50;

  let itemLines = "";
  try {
    const vision = typeof lead.vision_analysis === "string" ? JSON.parse(lead.vision_analysis) : lead.vision_analysis;
    if (vision && vision.items && vision.items.length > 0) {
      itemLines = "Items flagged for removal:\n" + vision.items.map(i => "• " + i).join("\n");
    }
  } catch(e) {}

  const parts = [
    "Your ICL Junk Removal quote is ready.",
    "",
    "Load: " + bucket + "  |  Total: $" + total,
    ""
  ];
  if (itemLines) { parts.push(itemLines); parts.push(""); }
  parts.push("To lock your spot, place a $" + deposit + " deposit here:");
  parts.push(paymentUrl);
  parts.push("");
  parts.push("After deposit, choose your arrival window: 8-10am, 10-12pm, 12-2pm, 2-4pm, or 4-6pm.");
  return parts.join("\n");
}

async function getLead(from_phone) {
  const res = await pool.query("SELECT * FROM leads WHERE from_phone = $1", [from_phone]);
  return res.rows[0] || null;
}

async function claimForQuoting(from_phone) {
  const res = await pool.query(`
    UPDATE leads
    SET quote_status = 'QUOTING',
        last_seen_at = NOW()
    WHERE from_phone = $1
      AND quote_ready = 1
      AND (quote_status IS NULL OR quote_status = '' OR quote_status = 'READY' OR quote_status = 'ERROR')
  `, [from_phone]);
  return res.rowCount === 1;
}

function setError(from_phone, err) {
  pool.query("UPDATE leads SET quote_status='ERROR', last_seen_at=NOW() WHERE from_phone=$1", [from_phone]).catch(()=>{});

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
  pool.query('UPDATE leads SET last_seen_at=NOW() WHERE from_phone=$1', [from_phone]).catch(()=>{});

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
  const lead0 = await getLead(from_phone);
  if (!lead0) return { ok: false, reason: "no_lead" };

  if (!claimForQuoting(from_phone)) {
    return { ok: true, changed: false, reason: "not_claimed" };
  }

  try {
    const lead = await getLead(from_phone);

    const pricing = priceQuoteV1({
      load_bucket: lead.load_bucket,
      distance_miles: lead.distance_miles || 0,
      access_level: lead.access_level,
    });

    writePricing(from_phone, pricing);

    const square = await createSquarePaymentLink(lead, pricing.total_cents);

    await pool.query(
      'UPDATE leads SET square_payment_link_id=$1, square_payment_link_url=$2, square_order_id=$3, quote_status=\'AWAITING_DEPOSIT\', last_seen_at=NOW() WHERE from_phone=$4',
      [square.payment_link_id, square.payment_link_url, square.order_id, from_phone]
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

    pool.query("UPDATE leads SET quote_status='AWAITING_DEPOSIT', last_seen_at=NOW() WHERE from_phone=$1", [from_phone]).catch(()=>{});

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
