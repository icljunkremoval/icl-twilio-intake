const { db, pool, insertEvent } = require("./db");
const {
  priceQuoteV1,
  priceClearoutBySqftV1,
  shouldUseSqftClearout,
} = require("./pricing_v1");
const { createSquarePaymentOptions } = require("./square_quote");
const { sendSms } = require("./twilio_sms");
const { lookupSqftByAddress } = require("./property_sqft");

const DEPOSIT_CENTS = 5000;
const UPFRONT_DISCOUNT_PCT = 10;

function buildQuoteSms(lead, pricing, payment) {
  const bucket = pricing.bucket;
  const total = (pricing.total_cents / 100).toFixed(0);
  const deposit = (DEPOSIT_CENTS / 100).toFixed(0);
  const upfrontTotal = (payment.upfrontTotalCents / 100).toFixed(0);
  const savings = ((payment.quoteTotalCents - payment.upfrontTotalCents) / 100).toFixed(0);

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
  if (pricing && pricing.strategy === "SQFT_CLEAROUT" && Number(pricing.property_sqft || 0) > 0) {
    parts.push("Clearout estimate basis: ~" + Math.round(Number(pricing.property_sqft)) + " sqft + photo analysis.");
    parts.push("");
  }
  if (itemLines) { parts.push(itemLines); parts.push(""); }
  parts.push("Choose your checkout option:");
  parts.push("1) Reserve with $" + deposit + " deposit:");
  parts.push(payment.deposit.payment_link_url);
  parts.push("");
  parts.push("2) Pay upfront and save 10% ($" + savings + " off, total $" + upfrontTotal + "):");
  parts.push(payment.upfront.payment_link_url);
  parts.push("");
  parts.push("After payment, we send your booking confirmation + scheduling link.");
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

function safeParseVision(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function chooseLoadBucketForPricing(lead, vision) {
  const normalize = (raw) => {
    const v = String(raw || "").toUpperCase().trim();
    if (v === "SMALL") return "MIN";
    if (v === "MEDIUM") return "HALF";
    if (v === "LARGE") return "FULL";
    if (v === "MIN" || v === "QTR" || v === "HALF" || v === "3Q" || v === "FULL") return v;
    return "";
  };
  const fromLead = normalize(lead?.load_bucket);
  if (fromLead) return fromLead;
  const fromVision = normalize(lead?.vision_load_bucket || vision?.load_bucket);
  if (fromVision) return fromVision;
  const fromCustomer = normalize(lead?.customer_load_bucket);
  if (fromCustomer) return fromCustomer;
  return "HALF";
}

async function derivePricingForLead(lead) {
  const vision = safeParseVision(lead?.vision_analysis);
  const selectedBucket = chooseLoadBucketForPricing(lead, vision);
  const clearout = shouldUseSqftClearout({
    vision,
    load_bucket: selectedBucket,
    has_media: Number(lead?.has_media) === 1,
    num_media: Number(lead?.num_media || 0),
  });

  let lookup = null;
  let propertySqft = null;
  let propertySqftSource = null;
  let strategy = "LOAD_BUCKET";

  if (clearout.use) {
    const cachedSqft = Math.round(Number(lead?.property_sqft || 0));
    if (Number.isFinite(cachedSqft) && cachedSqft >= 200) {
      propertySqft = cachedSqft;
      propertySqftSource = String(lead?.property_sqft_source || "cached");
    } else {
      lookup = await lookupSqftByAddress({
        address: lead?.address_text,
        zip: lead?.zip || lead?.zip_text,
        load_bucket: selectedBucket,
      });
      if (lookup && lookup.ok && Number(lookup.sqft) > 0) {
        propertySqft = Math.round(Number(lookup.sqft));
        propertySqftSource = String(lookup.source || "rentcast");
      } else if (lookup && Number(lookup.fallback_sqft) > 0) {
        propertySqft = Math.round(Number(lookup.fallback_sqft));
        propertySqftSource = "fallback";
      }
    }
  }

  let pricing;
  if (propertySqft && clearout.use) {
    strategy = propertySqftSource === "fallback" ? "SQFT_CLEAROUT_FALLBACK" : "SQFT_CLEAROUT";
    pricing = priceClearoutBySqftV1({
      property_sqft: propertySqft,
      load_bucket: selectedBucket,
      distance_miles: lead?.distance_miles || 0,
      access_level: lead?.access_level,
      photo_count: Number(vision?.photo_count || lead?.num_media || 0),
    });
  } else {
    if (clearout.use) strategy = "LOAD_BUCKET_FALLBACK_NO_SQFT";
    pricing = priceQuoteV1({
      load_bucket: selectedBucket,
      distance_miles: lead?.distance_miles || 0,
      access_level: lead?.access_level,
    });
  }

  return {
    pricing,
    strategy,
    clearout_detected: clearout.use,
    clearout_reasons: clearout.reasons || [],
    property_sqft: propertySqft,
    property_sqft_source: propertySqftSource,
    sqft_lookup: lookup,
  };
}

async function maybeCreateQuote(from_phone) {
  const lead0 = await getLead(from_phone);
  if (!lead0) return { ok: false, reason: "no_lead" };

  if (!(await claimForQuoting(from_phone))) {
    return { ok: true, changed: false, reason: "not_claimed" };
  }

  try {
    const lead = await getLead(from_phone);

    const decision = await derivePricingForLead(lead);
    const pricing = decision.pricing;
    const pricingEvent = {
      ...pricing,
      pricing_strategy: decision.strategy,
      clearout_detected: decision.clearout_detected,
      clearout_reasons: decision.clearout_reasons,
      property_sqft: decision.property_sqft,
      property_sqft_source: decision.property_sqft_source,
      sqft_lookup: decision.sqft_lookup ? {
        ok: decision.sqft_lookup.ok,
        source: decision.sqft_lookup.source,
        reason: decision.sqft_lookup.reason,
        matched_address: decision.sqft_lookup.matched_address || null,
      } : null,
    };

    writePricing(from_phone, pricingEvent);

    const payment = await createSquarePaymentOptions(lead, {
      quoteTotalCents: pricing.total_cents,
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
           pricing_strategy=$10,
           clearout_detected=$11,
           clearout_reason=$12,
           property_sqft=COALESCE($13,property_sqft),
           property_sqft_source=COALESCE($14,property_sqft_source),
           last_seen_at=NOW()
       WHERE from_phone=$15`,
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
        decision.strategy,
        decision.clearout_detected ? 1 : 0,
        (decision.clearout_reasons || []).join(", ") || null,
        decision.property_sqft || null,
        decision.property_sqft_source || null,
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

    const smsBody = buildQuoteSms(lead, pricing, payment);
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
      pricing_strategy: decision.strategy,
      clearout_detected: decision.clearout_detected,
      property_sqft: decision.property_sqft || null,
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

module.exports = { maybeCreateQuote, derivePricingForLead };
