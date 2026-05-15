const { db, pool, insertEvent } = require("./db");
const { priceQuoteV1, computeAddonTotalCents } = require("./pricing_v1");
const { createSquarePaymentOptions } = require("./square_quote");
const { sendSms } = require("./twilio_sms");
const { lookupSqftByAddress } = require("./property_sqft");

const DEPOSIT_CENTS = 5000;
const UPFRONT_DISCOUNT_PCT = 10;
const MAX_QUOTE_SMS_CHARS = 1450;
const OPS_PHONE = String(process.env.OPS_PHONE || process.env.OPS_ALERT_PHONE || "+12138806318").trim();
const ESCALATION_CUSTOMER_MESSAGE =
  "Got it — thank you for reaching out to ICL. We've received your\n" +
  "information and someone from our team will be in touch shortly\n" +
  "to walk you through your options. Feel free to send any photos\n" +
  "of the space in the meantime — it helps us get you the most\n" +
  "accurate quote possible.";
const PATH_1_FULL_HOME = "path_1_full_home";

function roundPath1BaseCents(sqft) {
  const s = Math.max(0, Math.round(Number(sqft || 0)));
  if (!s) return 124700;
  return Math.max(124700, Math.round((s * 85) / 500) * 500);
}

function parseSelectedAddons(rawAddons) {
  let addons = rawAddons;
  if (typeof addons === "string") {
    try { addons = JSON.parse(addons); } catch (_) { addons = []; }
  }
  if (!Array.isArray(addons)) return [];
  return addons;
}

function prettyAddonName(code) {
  const normalized = String(code || "").toUpperCase().trim();
  if (normalized === "DEEP_CLEAN") return "Deep Clean";
  if (normalized === "PRESSURE_WASH") return "Pressure Wash";
  if (normalized === "PAINT_TOUCHUP" || normalized === "PAINT_TOUCHUPS") return "Paint Touch-Ups";
  if (normalized === "MINOR_REPAIRS") return "Minor Repairs";
  return normalized;
}

function selectedAddonNames(addons) {
  const selected = parseSelectedAddons(addons);
  return selected
    .map((a) => prettyAddonName(a?.code || a))
    .filter(Boolean);
}

function buildQuoteSms(lead, pricing, payment) {
  const intakePath = String(lead?.intake_path || "");
  const isPath1 = intakePath === PATH_1_FULL_HOME || String(lead?.job_scope || "") === "full_home";
  if (isPath1) {
    const totalCents = Number(payment?.quoteTotalCents || pricing?.total_with_addons_cents || pricing?.total_cents || 0);
    const depositCents = Number(payment?.depositCents || payment?.deposit?.amount_cents || Math.round(totalCents / 2));
    const totalStr = "$" + Math.round(totalCents / 100).toLocaleString("en-US");
    const depositStr = "$" + Math.round(depositCents / 100).toLocaleString("en-US");
    const addonNames = selectedAddonNames(lead?.prelisting_addons || lead?.selected_addons);
    const addonLine = addonNames.length ? "\nIncludes: " + addonNames.join(", ") + "\n" : "\n";
    return (
      "Your quote for " + String(lead?.address_text || "your property") + ":\n\n" +
      totalStr + " all-inclusive" +
      addonLine +
      "\nCovers haul, dump fees, and our 7-day ICL Standard guarantee.\n\n" +
      depositStr + " deposit secures the date:\n" +
      String(payment?.deposit?.payment_link_url || "") +
      "\n\nQuestions? Just reply."
    );
  }
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

function buildCompactQuoteSms(pricing, payment) {
  if (String(pricing?.path || "") === "full_home_rentcast" || String(pricing?.path || "") === "full_home_fallback") {
    return [
      "Your quote is ready.",
      "Deposit link:",
      payment?.deposit?.payment_link_url || "",
      "",
      "Questions? Just reply."
    ].join("\n");
  }
  const bucket = String(pricing?.bucket || "HALF");
  const total = (Number(payment?.quoteTotalCents || pricing?.total_cents || 0) / 100).toFixed(0);
  const deposit = (DEPOSIT_CENTS / 100).toFixed(0);
  const upfrontTotal = (Number(payment?.upfrontTotalCents || 0) / 100).toFixed(0);
  const upfrontSavings = ((Number(payment?.quoteTotalCents || 0) - Number(payment?.upfrontTotalCents || 0)) / 100).toFixed(0);
  return [
    "Your ICL quote is ready.",
    "Load: " + bucket + " | Total: $" + total,
    "",
    "1) Reserve with $" + deposit + " deposit:",
    payment?.deposit?.payment_link_url || "",
    "",
    "2) Pay upfront and save " + Number(payment?.upfrontDiscountPct || UPFRONT_DISCOUNT_PCT) + "% ($" + upfrontSavings + " off, total $" + upfrontTotal + "):",
    payment?.upfront?.payment_link_url || "",
    "",
    "Reply 1–5 for your arrival window after checkout."
  ].join("\n");
}

function normalizeDestinationPhone(from_phone) {
  return String(from_phone || "").trim();
}

function twilioConfigSnapshot() {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || "");
  const token = String(process.env.TWILIO_AUTH_TOKEN || "");
  const messagingServiceSid = String(process.env.TWILIO_MESSAGING_SERVICE_SID || "");
  const fromNumber = String(process.env.TWILIO_FROM_NUMBER || "");
  return {
    hasAccountSid: Boolean(sid),
    accountSidPrefix: sid ? sid.slice(0, 6) : null,
    hasAuthToken: Boolean(token),
    hasMessagingServiceSid: Boolean(messagingServiceSid),
    hasFromNumber: Boolean(fromNumber),
  };
}

function assertTwilioSmsConfig() {
  const snapshot = twilioConfigSnapshot();
  console.log("[quote] twilio config snapshot:", snapshot);
  if (!snapshot.hasAccountSid || !snapshot.hasAuthToken) {
    throw new Error("Twilio credentials missing at quote SMS send time");
  }
  if (!snapshot.hasMessagingServiceSid && !snapshot.hasFromNumber) {
    throw new Error("Twilio sender missing at quote SMS send time");
  }
}

async function sendQuoteSmsWithFallback(from_phone, lead, pricing, payment) {
  const toPhone = normalizeDestinationPhone(from_phone);
  assertTwilioSmsConfig();

  const fullBody = String(buildQuoteSms(lead, pricing, payment) || "");
  try {
    if (fullBody.length > MAX_QUOTE_SMS_CHARS) {
      throw new Error("quote_sms_too_long_full_template");
    }
    const messageText = fullBody;
    console.log('[quote] attempting SMS send to:', toPhone);
    console.log('[quote] message length:', messageText.length);
    const result = await sendSms(toPhone, messageText);
    console.log('[quote] send result:', result);
    return { sms: result, template: "QUOTE_LINK_V1_FULL" };
  } catch (errFull) {
    console.error("[quote] full SMS send failed:", errFull && errFull.stack ? errFull.stack : errFull);
    try {
      insertEvent.run({
        from_phone,
        event_type: "quote_sms_full_failed",
        payload_json: JSON.stringify({ error: String(errFull?.message || errFull) }),
        created_at: new Date().toISOString(),
      });
    } catch (_) {}
    const compactBody = String(buildCompactQuoteSms(pricing, payment) || "");
    if (compactBody.length > MAX_QUOTE_SMS_CHARS) {
      throw new Error("quote_sms_too_long_compact_template");
    }
    try {
      const messageText = compactBody;
      console.log('[quote] attempting SMS send to:', toPhone);
      console.log('[quote] message length:', messageText.length);
      const result = await sendSms(toPhone, messageText);
      console.log('[quote] send result:', result);
      return { sms: result, template: "QUOTE_LINK_V1_COMPACT_FALLBACK" };
    } catch (errCompact) {
      console.error("[quote] compact SMS fallback send failed:", errCompact && errCompact.stack ? errCompact.stack : errCompact);
      throw errCompact;
    }
  }
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
  console.error("[quote] setError for", from_phone, err && err.stack ? err.stack : err);
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
    let needsManualReview = false;
    const intakePath = String(lead?.intake_path || "");
    const isPath1 = intakePath === PATH_1_FULL_HOME || String(lead?.job_scope || "") === "full_home";
    let addonTotalCents = addonTotalFromLead(lead);
    let selectedAddons = parseSelectedAddons(lead?.prelisting_addons || lead?.selected_addons);

    if (isPath1) {
      pricingPath = "full_home_fallback";
      let rentcastLookup = null;
      try {
        rentcastLookup = await lookupSqftByAddress({
          address: lead?.address_text,
          zip: lead?.zip || lead?.zip_text,
          load_bucket: selectedBucket,
        });
        if (rentcastLookup && rentcastLookup.ok && Number(rentcastLookup.sqft) > 0) {
          rentcastSqft = Math.round(Number(rentcastLookup.sqft));
          baseQuoteCents = roundPath1BaseCents(rentcastSqft);
          pricingPath = "full_home_rentcast";
        }
      } catch (_) {}
      if (!rentcastSqft) {
        baseQuoteCents = 124700;
        needsManualReview = true;
        crewNote = "Path 1 RentCast lookup unavailable — defaulted to $1,247 minimum.";
        try {
          insertEvent.run({
            from_phone,
            event_type: "path1_rentcast_fallback_used",
            payload_json: JSON.stringify({ reason: rentcastLookup?.reason || "lookup_failed" }),
            created_at: new Date().toISOString(),
          });
        } catch (_) {}
      }
      addonTotalCents = computeAddonTotalCents(selectedAddons, rentcastSqft || 1500);
    } else if (String(lead?.job_scope || "") === "room_garage") {
      pricingPath = "room_garage";
      if (selectedBucket === "3Q" || selectedBucket === "FULL") softFlag = 1;
    } else if (String(lead?.job_scope || "") === "few_items") {
      pricingPath = "few_items";
      if (selectedBucket === "HALF" || selectedBucket === "3Q" || selectedBucket === "FULL") {
        crewNote = "Few-items intake returned larger load bucket — confirm scope on arrival.";
      }
    }
    const quoteTotalWithAddons = baseQuoteCents + addonTotalCents;
    const pricingWithAddons = {
      ...pricing,
      bucket: selectedBucket,
      path: pricingPath,
      base_path_total_cents: baseQuoteCents,
      rentcast_sqft: rentcastSqft,
      selected_addons: selectedAddons,
      addon_total_cents: addonTotalCents,
      total_with_addons_cents: quoteTotalWithAddons,
    };

    writePricing(from_phone, pricingWithAddons);

    const depositCents = isPath1
      ? Math.max(100, Math.round(quoteTotalWithAddons / 2))
      : DEPOSIT_CENTS;
    const payment = await createSquarePaymentOptions(lead, {
      quoteTotalCents: quoteTotalWithAddons,
      depositCents,
      upfrontDiscountPct: UPFRONT_DISCOUNT_PCT
    });
    payment.depositCents = depositCents;

    await pool.query(
      `UPDATE leads
       SET square_payment_link_id=$1,
           square_payment_link_url=$2,
           square_order_id=$3,
           square_upfront_payment_link_id=$4,
           square_upfront_payment_link_url=$5,
           square_upfront_order_id=$6,
           quote_total_cents=$7,
           base_price_cents=$8,
           addon_total_cents=$9,
           total_cents=$10,
           upfront_total_cents=$11,
           upfront_discount_pct=$12,
           quote_status='AWAITING_DEPOSIT',
           last_seen_at=NOW()
       WHERE from_phone=$13`,
      [
        payment.deposit.payment_link_id,
        payment.deposit.payment_link_url,
        payment.deposit.order_id,
        payment.upfront.payment_link_id,
        payment.upfront.payment_link_url,
        payment.upfront.order_id,
        payment.quoteTotalCents,
        baseQuoteCents,
        addonTotalCents,
        quoteTotalWithAddons,
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
             WHEN $4::text IS NULL OR $4::text = '' THEN crew_notes
             WHEN crew_notes IS NULL OR crew_notes = '' THEN $4::text
             WHEN crew_notes ILIKE '%' || $4::text || '%' THEN crew_notes
             ELSE crew_notes || ' ' || $4::text
           END,
           needs_manual_review = $5,
           prelisting_addon_total_cents = CASE WHEN $7::int = 1 THEN $8 ELSE prelisting_addon_total_cents END,
           last_seen_at = NOW()
       WHERE from_phone = $6`,
      [selectedBucket, rentcastSqft, softFlag, crewNote, needsManualReview, from_phone, isPath1 ? 1 : 0, addonTotalCents]
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

    const quoteSmsResult = await sendQuoteSmsWithFallback(from_phone, lead, pricingWithAddons, payment);
    const sms = quoteSmsResult.sms;

    try {
      insertEvent.run({
        from_phone,
        event_type: "sms_sent_quote_link",
        payload_json: JSON.stringify({ from_phone, template: quoteSmsResult.template, twilio: sms }),
        created_at: new Date().toISOString(),
      });
    } catch (e) {}

    pool.query(
      "UPDATE leads SET quote_status='AWAITING_DEPOSIT', conv_state='AWAITING_DEPOSIT', quote_ready=0, last_seen_at=NOW() WHERE from_phone=$1",
      [from_phone]
    ).catch(()=>{});

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
    console.error("[quote] maybeCreateQuote failed for", from_phone, e && e.stack ? e.stack : e);
    setError(from_phone, e);
    return { ok: false, reason: "error", error: String(e && e.message ? e.message : e) };
  }
}

module.exports = { maybeCreateQuote };
