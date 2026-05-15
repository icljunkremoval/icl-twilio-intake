const { db, pool, insertEvent } = require("./db");
const { priceQuoteV1 } = require("./pricing_v1");
const { createSquarePaymentOptions } = require("./square_quote");
const { sendSms } = require("./twilio_sms");

const DEPOSIT_CENTS = 5000;
const UPFRONT_DISCOUNT_PCT = 10;

function buildQuoteSms(lead, pricing, payment) {
  const bucket = pricing.bucket;
  const total = (Number(payment?.quoteTotalCents || pricing.total_cents || 0) / 100).toFixed(0);
  const deposit = (DEPOSIT_CENTS / 100).toFixed(0);
  const upfrontTotal = (payment.upfrontTotalCents / 100).toFixed(0);
  const upfrontSavings = ((payment.quoteTotalCents - payment.upfrontTotalCents) / 100).toFixed(0);
  const addonTotal = Math.max(0, Math.round(Number(pricing?.addon_total_cents || 0)));

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
  if (addonTotal > 0) {
    parts.push("Pre-listing add-ons: $" + (addonTotal / 100).toFixed(0));
    parts.push("");
  }
  if (itemLines) { parts.push(itemLines); parts.push(""); }
  parts.push("Pick your checkout option:");
  parts.push("1) Reserve with $" + deposit + " deposit:");
  parts.push(payment.deposit.payment_link_url);
  parts.push("");
  parts.push(
    "2) Pay upfront and save " +
    payment.upfrontDiscountPct +
    "% ($" +
    upfrontSavings +
    " off, total $" +
    upfrontTotal +
    "):"
  );
  parts.push(payment.upfront.payment_link_url);
  parts.push("");
  parts.push("Choose your arrival window: 8–10am, 10am–12pm, 12–2pm, 2–4pm, or 4–6pm.");
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

function addonTotalFromLead(lead) {
  const n = Math.round(Number(lead?.prelisting_addon_total_cents || 0));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

async function maybeCreateQuote(from_phone) {
  const lead0 = await getLead(from_phone);
  if (!lead0) return { ok: false, reason: "no_lead" };

  if (!(await claimForQuoting(from_phone))) {
    return { ok: true, changed: false, reason: "not_claimed" };
  }

  try {
    const lead = await getLead(from_phone);

    const pricing = priceQuoteV1({
      load_bucket: lead.load_bucket,
      distance_miles: lead.distance_miles || 0,
      access_level: lead.access_level,
    });
    const addonTotalCents = addonTotalFromLead(lead);
    const quoteTotalWithAddons = Number(pricing.total_cents || 0) + addonTotalCents;
    const pricingWithAddons = {
      ...pricing,
      addon_total_cents: addonTotalCents,
      total_with_addons_cents: quoteTotalWithAddons,
    };

    writePricing(from_phone, pricingWithAddons);

    const payment = await createSquarePaymentOptions(lead, {
      quoteTotalCents: quoteTotalWithAddons,
      depositCents: DEPOSIT_CENTS,
      upfrontDiscountPct: UPFRONT_DISCOUNT_PCT
    });

    await pool.query(
      `UPDATE leads
       SET square_payment_link_id=$1,
           square_payment_link_url=$2,
           square_order_id=$3,
           square_upfront_payment_link_id=$4,
           square_upfront_payment_link_url=$5,
           square_upfront_order_id=$6,
           quote_total_cents=$7,
           upfront_total_cents=$8,
           upfront_discount_pct=$9,
           quote_status='AWAITING_DEPOSIT',
           last_seen_at=NOW()
       WHERE from_phone=$10`,
      [
        payment.deposit.payment_link_id,
        payment.deposit.payment_link_url,
        payment.deposit.order_id,
        payment.upfront.payment_link_id,
        payment.upfront.payment_link_url,
        payment.upfront.order_id,
        payment.quoteTotalCents,
        payment.upfrontTotalCents,
        payment.upfrontDiscountPct,
        from_phone
      ]
    );

    try {
      insertEvent.run({
        from_phone,
        event_type: "square_quote_created",
        payload_json: JSON.stringify({
          from_phone,
          quote_total_cents: payment.quoteTotalCents,
          upfront_total_cents: payment.upfrontTotalCents,
          upfront_discount_pct: payment.upfrontDiscountPct,
          deposit: payment.deposit,
          upfront: payment.upfront
        }),
        created_at: new Date().toISOString(),
      });
    } catch (e) {}

    const smsBody = buildQuoteSms(lead, pricingWithAddons, payment);
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
      payment_link_url: payment.deposit.payment_link_url,
      upfront_payment_link_url: payment.upfront.payment_link_url,
      quote_total_cents: payment.quoteTotalCents,
      upfront_total_cents: payment.upfrontTotalCents,
      upfront_discount_pct: payment.upfrontDiscountPct,
      sms_sid: sms.sid,
      sms_status: sms.status,
    };
  } catch (e) {
    setError(from_phone, e);
    return { ok: false, reason: "error", error: String(e && e.message ? e.message : e) };
  }
}

module.exports = { maybeCreateQuote };
