const { pool } = require("./db");

function asInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function parseJson(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch { return null; }
}

function parseTs(v) {
  if (!v) return null;
  const d = new Date(v);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return d.toISOString();
}

function isDoneStep(ts) {
  return !!parseTs(ts);
}

function centsToDollars(cents) {
  const n = asInt(cents);
  if (n == null) return null;
  return Math.round((n / 100) * 100) / 100;
}

function estimateCentsFromMaybeDollars(v) {
  const n = asInt(v);
  if (n == null || n <= 0) return 0;
  // salvage_est_value historically stored as whole dollars.
  return n < 10000 ? n * 100 : n;
}

function deriveState(lead) {
  const conv = String(lead?.conv_state || "").trim();
  if (conv) return conv;
  const quote = String(lead?.quote_status || "").trim();
  if (quote) return quote;
  return "NEW";
}

function derivePaymentStatus(lead, quoteCents) {
  const q = String(lead?.quote_status || "").toUpperCase();
  if (Number(lead?.deposit_paid) === 1) {
    if (q.includes("BOOKING") || q.includes("WINDOW") || q.includes("DAY")) return "PAID · BOOKING";
    return "PAID";
  }
  if (lead?.square_upfront_payment_link_url || lead?.square_payment_link_url) return "QUOTE SENT · AWAITING PAYMENT";
  if ((quoteCents || 0) > 0) return "QUOTED";
  return "PENDING QUOTE";
}

function deriveRecommendedAction(lead, quoteCents) {
  const hasMedia = Number(lead?.has_media) === 1 || Number(lead?.num_media || 0) > 0 || !!lead?.media_url0;
  if (!hasMedia) return "Request photos";
  if (!(lead?.address_text || lead?.zip || lead?.zip_text)) return "Collect service address";
  if (!lead?.access_level) return "Collect access type";
  if (!lead?.load_bucket) return "Confirm load size";
  if (Number(lead?.deposit_paid) === 0 && (quoteCents || 0) > 0) return "Follow up on payment";
  if (Number(lead?.deposit_paid) === 1 && !String(lead?.timing_pref || "").trim()) return "Confirm arrival window";
  return "Review lead details";
}

function deriveVisionTopItems(lead) {
  const vision = parseJson(lead?.vision_analysis) || {};
  const items = Array.isArray(vision?.items) ? vision.items : [];
  return items
    .map((i) => String(i || "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function deriveVisionResellCount(lead) {
  const vision = parseJson(lead?.vision_analysis) || {};
  const resell = Array.isArray(vision?.resell_items) ? vision.resell_items : [];
  return resell.filter(Boolean).length;
}

function parseLatestQuoteCents(lead, latestEventsByPhone) {
  const fromDb = asInt(lead?.quote_total_cents);
  if (fromDb && fromDb > 0) return fromDb;

  const ev = latestEventsByPhone.get(String(lead?.from_phone || ""));
  if (!ev) return null;
  for (const type of ["square_quote_created", "pricing_v1"]) {
    const payload = parseJson(ev[type]);
    const total = asInt(payload?.total_cents || payload?.quote_total_cents);
    if (total && total > 0) return total;
  }
  return null;
}

async function loadLatestPricingEvents(phones) {
  if (!phones.length) return new Map();
  const out = new Map();
  const evRows = (
    await pool.query(
      `SELECT from_phone, event_type, payload_json, id
       FROM events
       WHERE from_phone = ANY($1)
         AND event_type IN ('square_quote_created', 'pricing_v1')
       ORDER BY id DESC`,
      [phones]
    )
  ).rows;

  for (const r of evRows) {
    const phone = String(r.from_phone || "");
    if (!phone) continue;
    let bucket = out.get(phone);
    if (!bucket) {
      bucket = {};
      out.set(phone, bucket);
    }
    if (!bucket[r.event_type]) bucket[r.event_type] = r.payload_json;
  }
  return out;
}

async function loadJourneyEvents(phones) {
  const out = new Map();
  if (!phones.length) return out;
  const tracked = [
    "inbound_raw",
    "media_received",
    "square_quote_created",
    "deposit_paid",
    "upfront_paid",
    "booking_link_scheduled",
    "day_selected",
    "window_selected",
    "job_completed",
    "sms_sent_quote_link",
    "sms_sent_window_picker"
  ];
  const rows = (
    await pool.query(
      `SELECT from_phone, event_type, payload_json, created_at, id
       FROM events
       WHERE from_phone = ANY($1)
         AND event_type = ANY($2)
       ORDER BY id DESC`,
      [phones, tracked]
    )
  ).rows;

  const labels = {
    inbound_raw: "Lead contacted",
    media_received: "Media received",
    square_quote_created: "Quote created",
    deposit_paid: "Deposit paid",
    upfront_paid: "Paid upfront",
    booking_link_scheduled: "Scheduled (booking link)",
    day_selected: "Scheduled (SMS)",
    window_selected: "Window selected",
    job_completed: "Job completed",
    sms_sent_quote_link: "Quote SMS sent",
    sms_sent_window_picker: "Post-pay SMS sent"
  };

  for (const r of rows) {
    const phone = String(r.from_phone || "");
    if (!phone) continue;
    let rec = out.get(phone);
    if (!rec) {
      rec = { latest: {}, recent: [], payment: null };
      out.set(phone, rec);
    }
    const type = String(r.event_type || "");
    if (!rec.latest[type]) rec.latest[type] = r;
    if (rec.recent.length < 8) {
      rec.recent.push({
        type,
        label: labels[type] || type,
        at: parseTs(r.created_at)
      });
    }
    if (!rec.payment && (type === "deposit_paid" || type === "upfront_paid")) {
      const payload = parseJson(r.payload_json) || {};
      rec.payment = {
        kind: type === "upfront_paid" ? "upfront" : "deposit",
        confirmation_id: payload.confirmation_id || null,
        paid_at: parseTs(r.created_at)
      };
    }
  }
  return out;
}

async function loadJobItemAgg(phones) {
  const out = new Map();
  if (!phones.length) return out;
  try {
    const rows = (
      await pool.query(
        `SELECT
           from_phone,
           UPPER(COALESCE(bucket, 'DUMP')) AS bucket,
           COUNT(*)::int AS item_count,
           COALESCE(SUM(est_value_low), 0)::int AS low_sum,
           COALESCE(SUM(est_value_high), 0)::int AS high_sum,
           ARRAY_REMOVE(ARRAY_AGG(item_name ORDER BY id DESC), NULL) AS item_names
         FROM job_items
         WHERE from_phone = ANY($1)
         GROUP BY from_phone, UPPER(COALESCE(bucket, 'DUMP'))`,
        [phones]
      )
    ).rows;

    for (const r of rows) {
      const phone = String(r.from_phone || "");
      if (!phone) continue;
      let rec = out.get(phone);
      if (!rec) {
        rec = {
          counts: { RESELL: 0, SCRAP: 0, DONATE: 0, DUMP: 0 },
          resaleLowCents: 0,
          resaleHighCents: 0,
          topItems: []
        };
        out.set(phone, rec);
      }
      const b = String(r.bucket || "DUMP");
      if (!rec.counts[b] && rec.counts[b] !== 0) rec.counts[b] = 0;
      rec.counts[b] += asInt(r.item_count) || 0;
      if (b === "RESELL") {
        rec.resaleLowCents += asInt(r.low_sum) || 0;
        rec.resaleHighCents += asInt(r.high_sum) || 0;
      }
      const names = Array.isArray(r.item_names) ? r.item_names : [];
      for (const n of names) {
        const item = String(n || "").trim();
        if (!item || rec.topItems.includes(item)) continue;
        rec.topItems.push(item);
        if (rec.topItems.length >= 4) break;
      }
    }
  } catch (e) {
    // table may not exist on very old deployments; fail soft
  }
  return out;
}

async function listWorldviewLeads({ limit = 80 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 80));
  const leads = (
    await pool.query(
      `SELECT
         from_phone,
         first_seen_at,
         last_seen_at,
         last_event,
         last_body,
         num_media,
         media_url0,
         address_text,
         zip,
         zip_text,
         has_media,
         conv_state,
         quote_status,
         load_bucket,
         customer_load_bucket,
         access_level,
         timing_pref,
         square_payment_link_url,
         square_upfront_payment_link_url,
         deposit_paid,
         quote_total_cents,
         upfront_total_cents,
         upfront_discount_pct,
         salvage_est_value,
         salvage_actual_value,
         vision_analysis
       FROM leads
       ORDER BY last_seen_at DESC NULLS LAST
       LIMIT $1`,
      [safeLimit]
    )
  ).rows;

  const phones = leads.map((l) => l.from_phone).filter(Boolean);
  const [latestEventsByPhone, jobAggByPhone, journeyByPhone] = await Promise.all([
    loadLatestPricingEvents(phones),
    loadJobItemAgg(phones),
    loadJourneyEvents(phones)
  ]);

  return leads.map((lead) => {
    const phone = String(lead.from_phone || "");
    const quoteTotalCents = parseLatestQuoteCents(lead, latestEventsByPhone);
    const upfrontTotalCents = asInt(lead.upfront_total_cents);
    const state = deriveState(lead);
    const paymentStatus = derivePaymentStatus(lead, quoteTotalCents);
    const journeyRaw = journeyByPhone.get(phone) || { latest: {}, recent: [], payment: null };

    const jobAgg = jobAggByPhone.get(phone) || {
      counts: { RESELL: 0, SCRAP: 0, DONATE: 0, DUMP: 0 },
      resaleLowCents: 0,
      resaleHighCents: 0,
      topItems: []
    };

    const visionTop = deriveVisionTopItems(lead);
    const fallbackResellCount = deriveVisionResellCount(lead);
    const resellCount = jobAgg.counts.RESELL || fallbackResellCount;
    const totalLogged = (jobAgg.counts.RESELL || 0) + (jobAgg.counts.SCRAP || 0) + (jobAgg.counts.DONATE || 0) + (jobAgg.counts.DUMP || 0);
    const dumpFallback = totalLogged === 0 && visionTop.length > 0 ? Math.max(0, visionTop.length - fallbackResellCount) : 0;

    const salvageEstCents = estimateCentsFromMaybeDollars(lead.salvage_est_value);
    const resaleLowCents = Math.max(jobAgg.resaleLowCents || 0, salvageEstCents || 0);
    const resaleHighCents = Math.max(jobAgg.resaleHighCents || 0, salvageEstCents || 0);
    const topItems = (jobAgg.topItems.length ? jobAgg.topItems : visionTop).slice(0, 3);
    const stepContactedAt = parseTs(lead.first_seen_at || journeyRaw.latest.inbound_raw?.created_at || null);
    const stepMediaAt = parseTs(journeyRaw.latest.media_received?.created_at || null);
    const stepQuotedAt = parseTs(journeyRaw.latest.square_quote_created?.created_at || null);
    const stepPaidAt = parseTs(
      journeyRaw.latest.upfront_paid?.created_at ||
      journeyRaw.latest.deposit_paid?.created_at ||
      (Number(lead.deposit_paid) === 1 ? lead.deposit_paid_at : null)
    );
    const stepScheduledAt = parseTs(
      journeyRaw.latest.booking_link_scheduled?.created_at ||
      journeyRaw.latest.day_selected?.created_at ||
      journeyRaw.latest.window_selected?.created_at ||
      (lead.timing_pref ? lead.last_seen_at : null)
    );
    const stepRemovedAt = parseTs(
      journeyRaw.latest.job_completed?.created_at ||
      (String(lead.quote_status || "").toUpperCase() === "COMPLETED" ? lead.last_seen_at : null)
    );
    const journeySteps = [
      { id: "contacted", label: "Contacted", done: isDoneStep(stepContactedAt), at: stepContactedAt },
      { id: "media", label: "Media", done: isDoneStep(stepMediaAt), at: stepMediaAt },
      { id: "quoted", label: "Quoted", done: isDoneStep(stepQuotedAt), at: stepQuotedAt },
      { id: "paid", label: "Paid", done: isDoneStep(stepPaidAt), at: stepPaidAt },
      { id: "scheduled", label: "Scheduled", done: isDoneStep(stepScheduledAt), at: stepScheduledAt },
      { id: "removed", label: "Removed", done: isDoneStep(stepRemovedAt), at: stepRemovedAt }
    ];
    const journeyProgress = journeySteps.reduce((s, st) => s + (st.done ? 1 : 0), 0);

    return {
      phone,
      created_at: lead.first_seen_at || lead.last_seen_at || null,
      last_seen_at: lead.last_seen_at || null,
      state,
      address: lead.address_text || null,
      zip: lead.zip || lead.zip_text || null,
      load_bucket: lead.load_bucket || lead.customer_load_bucket || null,
      quote_total_cents: quoteTotalCents || null,
      upfront_total_cents: upfrontTotalCents || null,
      payment_status: paymentStatus,
      hover: {
        state,
        quote_total_cents: quoteTotalCents || null,
        quote_total_dollars: centsToDollars(quoteTotalCents),
        upfront_total_cents: upfrontTotalCents || null,
        upfront_total_dollars: centsToDollars(upfrontTotalCents),
        upfront_discount_pct: asInt(lead.upfront_discount_pct),
        payment_status: paymentStatus,
        confirmation_id: journeyRaw.payment?.confirmation_id || null,
        payment_kind: journeyRaw.payment?.kind || null,
        items: {
          resell: resellCount,
          scrap: jobAgg.counts.SCRAP || 0,
          donate: jobAgg.counts.DONATE || 0,
          dump: (jobAgg.counts.DUMP || 0) + dumpFallback,
          top: topItems
        },
        value: {
          resale_low_cents: resaleLowCents,
          resale_high_cents: resaleHighCents,
          resale_low_dollars: centsToDollars(resaleLowCents),
          resale_high_dollars: centsToDollars(resaleHighCents),
          salvage_actual_cents: asInt(lead.salvage_actual_value) || 0
        },
        ops: {
          next_action: deriveRecommendedAction(lead, quoteTotalCents),
          timing_pref: lead.timing_pref || null
        },
        journey: {
          progress: journeyProgress,
          steps: journeySteps,
          recent: journeyRaw.recent
        }
      }
    };
  });
}

module.exports = { listWorldviewLeads };
