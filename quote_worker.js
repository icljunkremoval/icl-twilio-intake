const { db, pool, insertEvent } = require("./db");
const { priceQuoteV1 } = require("./pricing_v1");
const { createSquarePaymentOptions } = require("./square_quote");
const { sendSms } = require("./twilio_sms");
const { lookupSqftByAddress } = require("./property_sqft");

const DEPOSIT_CENTS = 5000;
const UPFRONT_DISCOUNT_PCT = 10;
const OPS_PHONE = String(process.env.OPS_PHONE || process.env.OPS_ALERT_PHONE || "+12138806318").trim();
const ESCALATION_CUSTOMER_MESSAGE =
  "Got it — thank you for reaching out to ICL. We've received your\n" +
  "information and someone from our team will be in touch shortly\n" +
  "to walk you through your options. Feel free to send any photos\n" +
  "of the space in the meantime — it helps us get you the most\n" +
  "accurate quote possible.";

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

function normalizeBucket(raw) {
  const v = String(raw || "").toUpperCase().trim();
  if (v === "SMALL") return "MIN";
  if (v === "MEDIUM") return "HALF";
  if (v === "LARGE") return "FULL";
  if (v === "MIN" || v === "QTR" || v === "HALF" || v === "3Q" || v === "FULL") return v;
  return "";
}

function chooseBucket(lead) {
  return (
    normalizeBucket(lead?.load_bucket) ||
    normalizeBucket(lead?.vision_load_bucket) ||
    normalizeBucket(lead?.customer_load_bucket) ||
    "HALF"
  );
}

function visionConfidenceFromLead(lead) {
  try {
    const vision = typeof lead?.vision_analysis === "string" ? JSON.parse(lead.vision_analysis || "{}") : (lead?.vision_analysis || {});
    const conf = String(vision?.load_confidence || "").toUpperCase().trim();
    if (conf === "HIGH" || conf === "MEDIUM" || conf === "LOW") return conf;
  } catch (_) {}
  return "NONE";
}

async function escalateQuoteFlow(from_phone, lead, reason) {
  try {
    await pool.query(
      "UPDATE leads SET conv_state='ESCALATED', quote_status='ESCALATED', escalation_reason=$1, last_seen_at=NOW() WHERE from_phone=$2",
      [reason, from_phone]
    );
    await sendSms(from_phone, ESCALATION_CUSTOMER_MESSAGE);
    await sendSms(
      OPS_PHONE,
      "ICL Escalation\n" +
      "Scope: " + String(lead?.job_scope || "unknown") + "\n" +
      "Phone: " + from_phone + "\n" +
      "Reason: " + reason + "\n" +
      "Address: " + String(lead?.address_text || "pending") + "\n" +
      "Call now."
    );
    try {
      insertEvent.run({
        from_phone,
        event_type: "escalation_triggered",
        payload_json: JSON.stringify({ reason, source: "quote_worker" }),
        created_at: new Date().toISOString(),
      });
    } catch (_) {}
  } catch (_) {}
}

async function maybeCreateQuote(from_phone) {
  const lead0 = await getLead(from_phone);
  if (!lead0) return { ok: false, reason: "no_lead" };

  if (!(await claimForQuoting(from_phone))) {
    return { ok: true, changed: false, reason: "not_claimed" };
  }

  try {
    const lead = await getLead(from_phone);
    const selectedBucket = chooseBucket(lead);

    const pricing = priceQuoteV1({
      load_bucket: selectedBucket,
      distance_miles: lead.distance_miles || 0,
      access_level: lead.access_level,
    });
    let baseQuoteCents = Number(pricing.total_cents || 0);
    let pricingPath = "default";
    let rentcastSqft = Number.isFinite(Number(lead?.rentcast_sqft)) ? Math.round(Number(lead.rentcast_sqft)) : null;
    let softFlag = Math.max(0, Math.round(Number(lead?.soft_flag || 0)));
    let crewNote = null;

    if (String(lead?.job_scope || "") === "full_home") {
      pricingPath = "full_home_fallback";
      let rentcastOk = false;
      try {
        const lookup = await lookupSqftByAddress({
          address: lead?.address_text,
          zip: lead?.zip || lead?.zip_text,
          load_bucket: selectedBucket,
        });
        if (lookup && lookup.ok && Number(lookup.sqft) > 0) {
          rentcastSqft = Math.round(Number(lookup.sqft));
          baseQuoteCents = Math.max(124700, Math.round(rentcastSqft * 85));
          pricingPath = "full_home_rentcast";
          rentcastOk = true;
        }
      } catch (_) {}
      const confidence = visionConfidenceFromLead(lead);
      if (!rentcastOk && confidence !== "HIGH") {
        await escalateQuoteFlow(from_phone, lead, "full_home_rentcast_failed_non_high_confidence");
        return { ok: true, changed: true, reason: "escalated_full_home_rentcast_failure" };
      }
    } else if (String(lead?.job_scope || "") === "room_garage") {
      pricingPath = "room_garage";
      if (selectedBucket === "3Q" || selectedBucket === "FULL") softFlag = 1;
    } else if (String(lead?.job_scope || "") === "few_items") {
      pricingPath = "few_items";
      if (selectedBucket === "HALF" || selectedBucket === "3Q" || selectedBucket === "FULL") {
        crewNote = "Few-items intake returned larger load bucket — confirm scope on arrival.";
      }
    }

    const addonTotalCents = addonTotalFromLead(lead);
    const quoteTotalWithAddons = baseQuoteCents + addonTotalCents;
    const pricingWithAddons = {
      ...pricing,
      bucket: selectedBucket,
      path: pricingPath,
      base_path_total_cents: baseQuoteCents,
      rentcast_sqft: rentcastSqft,
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
    await pool.query(
      `UPDATE leads
       SET load_bucket = COALESCE(NULLIF(load_bucket,''), $1),
           rentcast_sqft = COALESCE($2, rentcast_sqft),
           soft_flag = $3,
           crew_notes = CASE
             WHEN $4 IS NULL OR $4 = '' THEN crew_notes
             WHEN crew_notes IS NULL OR crew_notes = '' THEN $4
             WHEN crew_notes ILIKE '%' || $4 || '%' THEN crew_notes
             ELSE crew_notes || ' ' || $4
           END,
           last_seen_at = NOW()
       WHERE from_phone = $5`,
      [selectedBucket, rentcastSqft, softFlag, crewNote, from_phone]
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
