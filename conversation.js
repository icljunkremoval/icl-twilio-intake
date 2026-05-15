const { db, pool, upsertLead, insertEvent, getLead } = require("./db");
const twilio = require("twilio");
const { sendSms } = require("./twilio_sms");
const { maybeCreateQuote } = require("./quote_worker");
const { analyzeJobMedia, analyzeAllMedia } = require("./vision_analyzer");
const { backfillLatestMedia } = require("./twilio_media_backfill");
const { recomputeDerived } = require("./recompute");
const { createJobEvent } = require("./calendar");
const { getAddonSqft, calcDeepClean, calcPressureWash, calcPaintTouchup } = require("./pricing_v1");
const { notifyRealtorAssist } = require("./utils/notify_partner");

const STATES = {
  NEW: "NEW", AWAITING_MEDIA: "AWAITING_MEDIA", AWAITING_HAZMAT: "AWAITING_HAZMAT",
  AWAITING_ADDRESS: "AWAITING_ADDRESS", AWAITING_ACCESS: "AWAITING_ACCESS",
  AWAITING_ADDRESS_CONFIRM: "AWAITING_ADDRESS_CONFIRM",
  AWAITING_LOAD: "AWAITING_LOAD", QUOTE_READY: "QUOTE_READY",
  AWAITING_DEPOSIT: "AWAITING_DEPOSIT", BOOKING_SENT: "BOOKING_SENT",
  WINDOW_SELECTED: "WINDOW_SELECTED", AWAITING_DAY: "AWAITING_DAY", ESCALATED: "ESCALATED",
  AWAITING_SCOPE_TRIAGE: "AWAITING_SCOPE_TRIAGE",
  AWAITING_REFERRAL_SOURCE: "AWAITING_REFERRAL_SOURCE",
  AWAITING_AGENT_NAME: "AWAITING_AGENT_NAME",
  AWAITING_ADDON_SELECTION: "AWAITING_ADDON_SELECTION",
  AWAITING_POST_PAYMENT_REFERRAL: "AWAITING_POST_PAYMENT_REFERRAL",
  AWAITING_POST_BOOKING_REFERRAL: "AWAITING_POST_BOOKING_REFERRAL",
};

const ACCESS_MAP = {
  "CURB": "CURB", "DRIVEWAY": "DRIVEWAY", "GARAGE": "GARAGE",
  "INSIDE HOME": "INSIDE_HOME", "INSIDE": "INSIDE_HOME",
  "STAIRS": "STAIRS", "APARTMENT": "APARTMENT", "OTHER": "OTHER",
};

const LOAD_MAP = {
  "SMALL": "MIN", "MEDIUM": "HALF", "LARGE": "FULL",
  "MIN": "MIN", "QTR": "QTR", "HALF": "HALF", "3Q": "3Q", "FULL": "FULL",
};

const WINDOW_MAP = {
  "1": "8-10am", "2": "10-12pm", "3": "12-2pm", "4": "2-4pm", "5": "4-6pm",
  "8": "8-10am", "10": "10-12pm", "12": "12-2pm", "2": "2-4pm", "4": "4-6pm",
  "8-10": "8-10am", "10-12": "10-12pm", "12-2": "12-2pm", "2-4": "2-4pm", "4-6": "4-6pm",
};
const AFTER_DAY_WINDOW_MAP = {
  "1": "8a–11a",
  "2": "12p–4p",
  MORNING: "8a–11a",
  AFTERNOON: "12p–4p",
};

const REFERRAL_TIMEOUT_MS = 10 * 60 * 1000;
const SCOPE_TRIAGE_TIMEOUT_MS = 15 * 60 * 1000;
const ADDON_OFFER_TIMEOUT_MS = 15 * 60 * 1000;
const POST_PAYMENT_REFERRAL_TIMEOUT_MS = 10 * 60 * 1000;
const SCOPE_TRIAGE_PROMPT =
  "To get you the most accurate quote — which best describes your job?\n\n" +
  "1) Full home or estate clearout\n" +
  "2) One or two rooms / garage\n" +
  "3) A few items\n\n" +
  "Reply 1, 2, or 3.";
const REALTOR_ADDON_OFFER_PROMPT =
  "One more thing — since this is a pre-listing property, we also offer:\n\n" +
  "🧹 Deep Clean — $150\n" +
  "🚿 Pressure Wash — $125\n" +
  "🎨 Paint Touch-Ups — $175\n" +
  "🔧 Minor Repairs — quote on-site\n\n" +
  "Reply ADD to include any of these, or SKIP to proceed with your quote.";
const REALTOR_ADDON_CODE_MAP = {
  1: { code: "DEEP_CLEAN", label: "Deep Clean" },
  2: { code: "PRESSURE_WASH", label: "Pressure Wash" },
  3: { code: "PAINT_TOUCHUP", label: "Paint Touch-Ups" },
  4: { code: "MINOR_REPAIRS", label: "Minor Repairs (on-site quote)" },
};
const referralTimers = new Map();
const scopeTriageTimers = new Map();
const addonOfferTimers = new Map();
const OPS_PHONE = String(process.env.OPS_PHONE || process.env.OPS_ALERT_PHONE || "+12138806318").trim();
const ESCALATION_KEYWORDS = [
  "condemned", "biohazard", "hoarder", "hoarding",
  "fire damage", "flood damage", "mold", "asbestos",
  "whole house", "entire house", "everything in the house",
  "probate", "inherited", "passed away", "deceased",
  "speak to someone", "talk to someone", "call me", "need to talk"
];
const ESCALATION_CUSTOMER_MESSAGE =
  "Got it — thank you for reaching out to ICL. We've received your\n" +
  "information and someone from our team will be in touch shortly\n" +
  "to walk you through your options. Feel free to send any photos\n" +
  "of the space in the meantime — it helps us get you the most\n" +
  "accurate quote possible.";
const PATH_1_FULL_HOME = "path_1_full_home";
const PATH_2_ROOMS = "path_2_rooms";
const PATH_3_FEW_ITEMS = "path_3_few_items";
const PATH1_ADDRESS_PROMPT = "Got it — full home or estate clearout. What's the property address? (Street, city, state.)";
const PATH1_ACCESS_PROMPT =
  "Where will the crew be working? Tap one:\n" +
  "1) Inside the home\n" +
  "2) Garage\n" +
  "3) Curbside\n" +
  "4) Mix";
const PATH1_ADDON_PROMPT =
  "Want to add any of these to make the property listing-ready? Reply with any numbers (e.g. \"1 3\") or SKIP:\n" +
  "1) Deep Clean\n" +
  "2) Pressure Wash\n" +
  "3) Paint Touch-Ups";

function getConvState(lead) { return (lead && lead.conv_state) || STATES.NEW; }
function getIntakePath(lead) { return String(lead?.intake_path || "").trim(); }
function isPath1Lead(lead) { return getIntakePath(lead) === PATH_1_FULL_HOME; }

function logEvent(from_phone, event_type, data) {
  try { insertEvent.run({ from_phone, event_type, payload_json: JSON.stringify(data || {}), created_at: new Date().toISOString() }); } catch (e) {}
}

async function setState(from_phone, state) {
  try {
    await pool.query('UPDATE leads SET conv_state = $1, last_seen_at = NOW() WHERE from_phone = $2', [state, from_phone]);
  } catch (e) {
    console.error('[setState]', e.message);
  }
}

async function sendPhotoPrompt(from_phone) {
  await sendSms(
    from_phone,
    "Perfect — send us up to 10 photos of what you need removed. Different angles help us give you the most accurate quote."
  );
}

async function sendWindowPickerPrompt(from_phone) {
  await sendSms(
    from_phone,
    "Reply with your arrival window:\n1) 8–10am\n2) 10am–12pm\n3) 12–2pm\n4) 2–4pm\n5) 4–6pm"
  );
}

function buildDefaultDayOptions(now = new Date()) {
  const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const options = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    options.push(`${dayNames[d.getDay()]} ${monthNames[d.getMonth()]} ${d.getDate()}`);
  }
  return options;
}

function readDayOptionsSnapshot(lead) {
  try {
    const parsed = typeof lead?.day_options_snapshot === "string"
      ? JSON.parse(lead.day_options_snapshot)
      : lead?.day_options_snapshot;
    if (Array.isArray(parsed) && parsed.length >= 3) {
      const cleaned = parsed.slice(0, 3).map((v) => String(v || "").trim()).filter(Boolean);
      if (cleaned.length >= 3) return cleaned;
    }
  } catch (_) {}
  return buildDefaultDayOptions(new Date());
}

function formatDayPickerMenu(dayOptions) {
  const safe = Array.isArray(dayOptions) ? dayOptions : buildDefaultDayOptions(new Date());
  return "1) " + (safe[0] || "") + "\n" + "2) " + (safe[1] || "") + "\n" + "3) " + (safe[2] || "");
}

async function sendDayPickerPrompt(from_phone, lead) {
  const dayOptions = readDayOptionsSnapshot(lead);
  await sendSms(
    from_phone,
    "When works best for the crew? Tap a day:\n" + formatDayPickerMenu(dayOptions)
  );
}

async function sendAfterDayWindowPrompt(from_phone) {
  await sendSms(from_phone, "Pick an arrival window:\n1) Morning\n2) Afternoon");
}

function clearReferralTimeout(from_phone) {
  const key = String(from_phone || "");
  const t = referralTimers.get(key);
  if (t) clearTimeout(t);
  referralTimers.delete(key);
}

function clearScopeTriageTimeout(from_phone) {
  const key = String(from_phone || "");
  const t = scopeTriageTimers.get(key);
  if (t) clearTimeout(t);
  scopeTriageTimers.delete(key);
}

function scheduleScopeTriageTimeout(from_phone) {
  clearScopeTriageTimeout(from_phone);
  const key = String(from_phone || "");
  const timer = setTimeout(async () => {
    try {
      const cur = await getLead.get(from_phone);
      if (!cur) return;
      if (String(cur.conv_state || "") !== STATES.AWAITING_SCOPE_TRIAGE) return;
      await pool.query(
        `UPDATE leads
         SET job_scope = NULL,
             intake_path = NULL,
             conv_state = $1,
             last_seen_at = NOW()
         WHERE from_phone = $2`,
        [STATES.AWAITING_MEDIA, from_phone]
      );
      await sendPhotoPrompt(from_phone);
      logEvent(from_phone, "scope_triage_timeout_defaulted", { job_scope: null });
    } catch (_) {}
    clearScopeTriageTimeout(from_phone);
  }, SCOPE_TRIAGE_TIMEOUT_MS);
  scopeTriageTimers.set(key, timer);
}

function clearAddonOfferTimeout(from_phone) {
  const key = String(from_phone || "");
  const t = addonOfferTimers.get(key);
  if (t) clearTimeout(t);
  addonOfferTimers.delete(key);
}

function scheduleAddonOfferTimeout(from_phone) {
  clearAddonOfferTimeout(from_phone);
  const key = String(from_phone || "");
  const timer = setTimeout(async () => {
    try {
      const cur = await getLead.get(from_phone);
      if (!cur) return;
      if (String(cur.conv_state || "") !== STATES.AWAITING_ADDON_SELECTION) return;
      await pool.query(
        `UPDATE leads
         SET prelisting_addons = COALESCE(prelisting_addons, '[]'),
             prelisting_addon_total_cents = COALESCE(prelisting_addon_total_cents, 0),
             addon_deep_clean_cents = COALESCE(addon_deep_clean_cents, 0),
             addon_pressure_wash_cents = COALESCE(addon_pressure_wash_cents, 0),
             addon_paint_touchup_cents = COALESCE(addon_paint_touchup_cents, 0),
             conv_state = $1,
             quote_status='READY',
             quote_ready=1,
             last_seen_at = NOW()
         WHERE from_phone = $2`,
        [STATES.QUOTE_READY, from_phone]
      );
      await triggerQuote(from_phone);
    } catch (_) {}
    clearAddonOfferTimeout(from_phone);
  }, ADDON_OFFER_TIMEOUT_MS);
  addonOfferTimers.set(key, timer);
}

function getDynamicAddonPricing(lead) {
  const sqft = getAddonSqft(lead);
  const deepClean = calcDeepClean(sqft);
  const pressureWash = calcPressureWash(sqft);
  const paintTouchup = calcPaintTouchup(sqft);
  return {
    sqft,
    deepCleanDollars: deepClean,
    pressureWashDollars: pressureWash,
    paintTouchupDollars: paintTouchup,
    deepCleanCents: deepClean * 100,
    pressureWashCents: pressureWash * 100,
    paintTouchupCents: paintTouchup * 100,
  };
}

function scheduleReferralTimeout(from_phone) {
  clearReferralTimeout(from_phone);
  const key = String(from_phone || "");
  const timer = setTimeout(async () => {
    try {
      const cur = await getLead.get(from_phone);
      if (!cur) return;
      if (String(cur.conv_state || "") !== STATES.AWAITING_REFERRAL_SOURCE) return;
      await pool.query(
        `UPDATE leads
         SET lead_source=CASE WHEN lead_source IS NULL OR lead_source='' THEN 'sms' ELSE lead_source END,
             conv_state=$1,
             last_seen_at=NOW()
         WHERE from_phone=$2`,
        [STATES.AWAITING_MEDIA, from_phone]
      );
      await sendPhotoPrompt(from_phone);
      logEvent(from_phone, "referral_source_timeout_defaulted", {
        lead_source: String(cur.lead_source || "sms"),
      });
    } catch (_) {}
    clearReferralTimeout(from_phone);
  }, REFERRAL_TIMEOUT_MS);
  referralTimers.set(key, timer);
}

function detectEscalationKeywordReason(bodyLower) {
  const txt = String(bodyLower || "");
  for (const kw of ESCALATION_KEYWORDS) {
    if (txt.includes(kw)) return `keyword:${kw}`;
  }
  return null;
}

async function escalateLead(from_phone, reason, leadMaybe) {
  try {
    const lead = leadMaybe || (await getLead.get(from_phone));
    await pool.query(
      "UPDATE leads SET conv_state=$1, escalation_reason=$2, last_seen_at=NOW() WHERE from_phone=$3",
      [STATES.ESCALATED, reason, from_phone]
    );
    await sendSms(from_phone, ESCALATION_CUSTOMER_MESSAGE);
    const scope = String(lead?.job_scope || "unknown");
    const address = String(lead?.address_text || "pending");
    await sendSms(
      OPS_PHONE,
      "ICL Escalation\n" +
      "Scope: " + scope + "\n" +
      "Phone: " + from_phone + "\n" +
      "Reason: " + reason + "\n" +
      "Address: " + address + "\n" +
      "Call now."
    );
    logEvent(from_phone, "escalation_triggered", { reason, scope, address });
    return true;
  } catch (_) {
    return false;
  }
}

function formatAddonSelections(addons) {
  const src = Array.isArray(addons) ? addons : [];
  return src
    .map((a) => String(a?.label || a?.code || "").trim())
    .filter(Boolean)
    .join(", ");
}

async function notifyReferralPartner(from_phone) {
  try {
    const lead = await getLead.get(from_phone);
    if (!lead || String(lead.referral_partner || "") !== "realtor_assist") return;
    const result = await notifyRealtorAssist(lead);
    if (result.ok) {
      await pool.query(
        "UPDATE leads SET referral_notified_at=$1, last_seen_at=NOW() WHERE from_phone=$2",
        [result.sent_at || new Date().toISOString(), from_phone]
      );
      logEvent(from_phone, "referral_partner_notified", { partner: "realtor_assist" });
    } else {
      await pool.query(
        "UPDATE leads SET referral_notified_at=NULL, last_seen_at=NOW() WHERE from_phone=$1",
        [from_phone]
      );
      logEvent(from_phone, "referral_partner_notify_failed", { partner: "realtor_assist", error: result.error || result.reason || "unknown" });
    }
  } catch (_) {
    // must never break SMS flow
  }
}

function suggestedLoadFromVision(lead) {
  const b = String(lead?.vision_load_bucket || "").toUpperCase();
  if (!b) return null;
  if (b === "MIN" || b === "QTR") return "SMALL";
  if (b === "HALF") return "MEDIUM";
  if (b === "3Q" || b === "FULL") return "LARGE";
  return null;
}

async function sendLoadPrompt(from_phone, lead) {
  const hint = suggestedLoadFromVision(lead);
  let conf = "";
  try {
    const vision = typeof lead?.vision_analysis === "string" ? JSON.parse(lead.vision_analysis) : lead?.vision_analysis;
    conf = String(vision?.load_confidence || "").toUpperCase();
  } catch (e) {}
  const confSuffix = conf && conf !== "HIGH" ? ` (${conf} confidence)` : "";
  const prefix = hint ? `Photo estimate: ${hint}${confSuffix}. Please confirm below.\n\n` : "";
  await sendSms(from_phone, `${prefix}How much are you removing?\n\nSMALL — pickup-truck bed\nMEDIUM — half a truck\nLARGE — full truck`);
}

function readVisionLoad(lead) {
  let vision = null;
  try { vision = typeof lead?.vision_analysis === "string" ? JSON.parse(lead.vision_analysis) : lead?.vision_analysis; } catch (e) {}
  const bucket = String(lead?.vision_load_bucket || vision?.load_bucket || "").toUpperCase();
  const confidence = String(vision?.load_confidence || "").toUpperCase();
  return { bucket, confidence };
}

function normalizeVisionConfidence(raw) {
  const c = String(raw || "").toUpperCase().trim();
  if (c === "HIGH" || c === "MEDIUM" || c === "LOW") return c;
  return "NONE";
}

async function appendCrewNote(from_phone, note) {
  try {
    const row = await getLead.get(from_phone);
    const current = String(row?.crew_notes || "").trim();
    const next = current ? `${current} ${note}` : note;
    await pool.query("UPDATE leads SET crew_notes=$1, last_seen_at=NOW() WHERE from_phone=$2", [next, from_phone]);
  } catch (_) {}
}

async function maybeAutoQuoteFromVision(from_phone, reason = "vision_high_confidence") {
  const lead = await getLead.get(from_phone);
  if (!lead) return false;
  if (lead.load_bucket || lead.customer_load_bucket) return false;
  if (!lead.access_level) return false;
  if (!(lead.address_text || lead.zip || lead.zip_text)) return false;
  const { bucket, confidence } = readVisionLoad(lead);
  const normalizedConfidence = normalizeVisionConfidence(confidence);
  if (!bucket || normalizedConfidence === "NONE") {
    await escalateLead(from_phone, "vision_confidence_none_after_retry", lead);
    return false;
  }
  if (normalizedConfidence === "LOW") {
    const retry = Math.max(0, Math.round(Number(lead.low_confidence_retry || 0)));
    if (retry < 1) {
      await pool.query(
        "UPDATE leads SET low_confidence_retry=1, conv_state=$1, last_seen_at=NOW() WHERE from_phone=$2",
        [STATES.AWAITING_MEDIA, from_phone]
      );
      await sendSms(
        from_phone,
        "A couple more angles would help us nail your quote — can you send a few more photos showing the full space?"
      );
      logEvent(from_phone, "vision_low_confidence_retry_requested", { reason });
      return false;
    }
    await appendCrewNote(from_phone, "Load estimate is MEDIUM confidence — confirm on arrival.");
    logEvent(from_phone, "vision_low_confidence_retry_promoted", { reason });
  }
  if (normalizedConfidence === "MEDIUM") {
    await appendCrewNote(from_phone, "Load estimate is MEDIUM confidence — confirm on arrival.");
  }
  await pool.query(
    "UPDATE leads SET load_bucket=$1, low_confidence_retry=0, conv_state=$2, quote_ready=1, last_seen_at=NOW() WHERE from_phone=$3",
    [bucket, STATES.QUOTE_READY, from_phone]
  );
  logEvent(from_phone, "vision_load_autolock", { load_bucket: bucket, reason });
  const label = bucket === "MIN" || bucket === "QTR" ? "SMALL" : (bucket === "HALF" ? "MEDIUM" : "LARGE");
  await sendSms(
    from_phone,
    `Based on your photos, this appears to be a ${label.toLowerCase()} load. If you want to adjust it, reply SMALL, MEDIUM, or LARGE before checkout.`
  );
  await triggerQuote(from_phone);
  return true;
}

async function triggerQuote(from_phone) {
  let lead = null;
  try {
    lead = await getLead.get(from_phone);
    const isPath1 = isPath1Lead(lead);
    const isRealtorReferral = String(lead?.lead_source || "") === "realtor_referral";
    const hasAddonDecision = lead?.prelisting_addons !== null && lead?.prelisting_addons !== undefined && String(lead.prelisting_addons) !== "";
    if (isPath1 && !hasAddonDecision) {
      await pool.query(
        "UPDATE leads SET conv_state=$1, quote_status='READY', quote_ready=1, last_seen_at=NOW() WHERE from_phone=$2",
        [STATES.AWAITING_ADDON_SELECTION, from_phone]
      );
      await sendSms(from_phone, PATH1_ADDON_PROMPT);
      scheduleAddonOfferTimeout(from_phone);
      return;
    }
    if (!isPath1 && isRealtorReferral && !hasAddonDecision) {
      await pool.query(
        "UPDATE leads SET conv_state=$1, quote_status='READY', quote_ready=1, last_seen_at=NOW() WHERE from_phone=$2",
        [STATES.AWAITING_ADDON_SELECTION, from_phone]
      );
      await sendSms(from_phone, REALTOR_ADDON_OFFER_PROMPT);
      scheduleAddonOfferTimeout(from_phone);
      return;
    }
    clearAddonOfferTimeout(from_phone);
  } catch (_) {
    // fallback to normal quote path
  }
  try { await recomputeDerived(from_phone); } catch (e) {}
  try {
    const r = await maybeCreateQuote(from_phone);
    if (!r.ok) logEvent(from_phone, "quote_trigger_failed", r);
  } catch (e) {
    logEvent(from_phone, "quote_trigger_error", { error: String(e.message || e) });
  }
}

async function handleNewLead(lead, from_phone) {
  const latest = await getLead.get(from_phone);
  if (String(getConvState(latest || lead) || "") !== STATES.NEW) {
    console.log(`[handleNewLead] skipping — ${from_phone} already in state ${String(getConvState(latest || lead) || "")}`);
    return;
  }
  await setState(from_phone, STATES.AWAITING_SCOPE_TRIAGE);
  scheduleScopeTriageTimeout(from_phone);
  await sendSms(
    from_phone,
    "Hi! Thanks for texting ICL Junk Removal. We’re ready when you are."
  );
  await sendSms(from_phone, SCOPE_TRIAGE_PROMPT);
}

async function advanceAfterAddress(from_phone) {
  const lead = await getLead.get(from_phone);
  const hasAccess = lead && lead.access_level;
  if (hasAccess) {
    const autoQuoted = await maybeAutoQuoteFromVision(from_phone, "after_address");
    if (autoQuoted) return;
    setState(from_phone, STATES.AWAITING_LOAD);
    await sendLoadPrompt(from_phone, lead);
  } else {
    setState(from_phone, STATES.AWAITING_ACCESS);
    await sendSms(from_phone, "Where are the items?\n\nCURB / DRIVEWAY / GARAGE / INSIDE HOME / STAIRS / APARTMENT / OTHER");
  }
}

function runVisionAsync(from_phone, mediaUrl, allUrls) {
  const urlsToAnalyze = allUrls && allUrls.length > 0 ? allUrls : [mediaUrl];
  analyzeAllMedia(urlsToAnalyze).then((vision) => {
    logEvent(from_phone, "vision_analysis", vision);
    try {
      pool.query('UPDATE leads SET vision_analysis=$1,troll_flag=$2,crew_notes=$3,item_tags=$4,vision_load_bucket=$5,vision_access_level=$6,last_seen_at=NOW() WHERE from_phone=$7', [JSON.stringify(vision), vision.troll_flag?1:0, vision.crew_notes||null, JSON.stringify(vision.data_tags||[]), vision.load_bucket||null, vision.access_level||null, from_phone]).catch(()=>{});
    } catch(e) {
      pool.query('UPDATE leads SET vision_analysis=$1,troll_flag=$2,crew_notes=$3,item_tags=$4,last_seen_at=NOW() WHERE from_phone=$5', [JSON.stringify(vision),vision.troll_flag?1:0,vision.crew_notes||null,JSON.stringify(vision.data_tags||[]),from_phone]).catch(()=>{});
    }
    if (vision.troll_flag || !vision.is_valid_junk) {
      setState(from_phone, STATES.ESCALATED);
      sendSms(from_phone, "Thanks for reaching out! We couldn't identify junk removal items in your photo. Send a clearer photo or reply HELP to reach our team.").catch(()=>{});
      return;
    }
    const updates=[]; const params=[];
    if (vision.load_bucket) { logEvent(from_phone,"vision_load_hint",{load_bucket:vision.load_bucket,load_confidence:vision.load_confidence||null}); }
    if (vision.access_level && vision.access_level!=="UNKNOWN" && vision.access_confidence==="HIGH") { updates.push("access_level=?"); params.push(vision.access_level); logEvent(from_phone,"vision_access_set",{access_level:vision.access_level}); }
    if (updates.length>0) {
      const cols = updates.map(u => u.split('=')[0]);
      const pgU = cols.map((col, idx) => col+'=$'+(idx+1));
      params.push(from_phone);
      pool.query("UPDATE leads SET "+pgU.join(",")+",last_seen_at=NOW() WHERE from_phone=$"+(cols.length+1), params).catch(()=>{});
    }
    setTimeout(() => {
      maybeAutoQuoteFromVision(from_phone, "vision_async").catch(()=>{});
    }, 220);
  }).catch((e)=>{ logEvent(from_phone,"vision_error",{error:String(e.message||e)}); });
}

async function handleConversation(payload) {
  const from_phone = payload.From;
  const to_phone = payload.To;
  const body = (payload.Body || "").trim();
  const numMedia = Number(payload.NumMedia || 0);
  const mediaUrl = payload.MediaUrl0 || "";
  // Capture all media URLs for multi-photo support
  const allMediaUrls = [];
  for (let i = 0; i < Math.min(numMedia, 10); i++) {
    const u = payload["MediaUrl" + i];
    if (u) allMediaUrls.push(u);
  }
  const bodyUpper = body.toUpperCase();
  const bodyLower = body.toLowerCase();

  try { upsertLead.run({from_phone,to_phone,ts:new Date().toISOString(),last_event:"message",last_body:body,num_media:numMedia,media_url0:mediaUrl||null}); } catch(e){}
  // Alert ops on first contact
  try {
    const existingLead = await getLead.get(from_phone);
    const eventCount = await pool.query("SELECT COUNT(*) as cnt FROM events WHERE from_phone=$1", [from_phone]);
    if (parseInt(eventCount.rows[0].cnt) <= 1) {
      sendSms("+12138806318", "📲 NEW LEAD\n" + from_phone + "\nJust texted in. Flow started.").catch(()=>{});
    }
  } catch(e) {}

  const lead = await getLead.get(from_phone);
  const state = getConvState(lead);

  if (state !== STATES.ESCALATED) {
    const escalationReason = detectEscalationKeywordReason(bodyLower);
    if (escalationReason) {
      const escalated = await escalateLead(from_phone, escalationReason, lead);
      if (escalated) return;
    }
  }

  if (bodyUpper==="URGENT") { logEvent(from_phone,"urgent_flag",{body}); await sendSms(from_phone,"Got it — flagged URGENT. We'll prioritize your job."); return; }
  if (bodyUpper==="HELP") {
    logEvent(from_phone,"help_requested",{body});
    setState(from_phone,STATES.ESCALATED);
    await sendSms(from_phone,"Connecting you now — expect a call from 213-880-6318 in seconds.");
    await sendSms("+12138806318", "HELP REQUEST\nPhone: "+from_phone+"\nLast message: "+body+"\nCalling them now.");
    try {
      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilioClient.calls.create({
        to: from_phone,
        from: "+12138806318",
        twiml: "<Response><Say voice=\"Google.en-US-Neural2-F\">This is ICL Junk Removal. A team member will be with you shortly. Please hold.</Say><Dial>+12138806318</Dial></Response>"
      });
      logEvent(from_phone,"help_call_initiated",{});
    } catch(e) {
      console.error("[help] call failed:", e.message);
      await sendSms(from_phone,"Please call us directly at 213-880-6318 and we will take care of you.");
    }
    return;
  }

  switch(state) {
    case STATES.NEW: {
      await handleNewLead(lead, from_phone);
      break;
    }

    case STATES.AWAITING_SCOPE_TRIAGE: {
      const bodyTrim = String(body || "").trim();
      let jobScope = null;
      let intakePath = null;
      let nextState = STATES.AWAITING_MEDIA;
      let nextPrompt = null;
      if (/\b1\b/.test(bodyTrim)) {
        jobScope = "full_home";
        intakePath = PATH_1_FULL_HOME;
        nextState = STATES.AWAITING_ADDRESS;
        nextPrompt = PATH1_ADDRESS_PROMPT;
      } else if (/\b2\b/.test(bodyTrim)) {
        jobScope = "room_garage";
        intakePath = PATH_2_ROOMS;
      } else if (/\b3\b/.test(bodyTrim)) {
        jobScope = "few_items";
        intakePath = PATH_3_FEW_ITEMS;
      }

      if (!jobScope) {
        await sendSms(from_phone, "Reply 1, 2, or 3 — whichever fits best.");
        break;
      }

      try {
        await pool.query(
          `UPDATE leads
           SET job_scope = $1,
               intake_path = $2,
               conv_state = $3,
               last_seen_at = NOW()
           WHERE from_phone = $4`,
          [jobScope, intakePath, nextState, from_phone]
        );
      } catch (_) {}
      clearScopeTriageTimeout(from_phone);
      if (nextPrompt) await sendSms(from_phone, nextPrompt);
      else await sendPhotoPrompt(from_phone);
      break;
    }

    case STATES.AWAITING_REFERRAL_SOURCE: {
      try {
        const bodyLower = String(body || "").trim().toLowerCase();
        const isYes = [
          "yes","yeah","yep","yup","yea","sure","absolutely",
          "correct","referred by","my agent","my realtor","through my"
        ].some((word) => bodyLower.includes(word));
        const isNo = [
          "no","nope","nah","not really","nobody","direct",
          "myself","found you","google","online","facebook","instagram"
        ].some((word) => bodyLower.includes(word));
        console.log('[referral] body:', bodyLower, 'isYes:', isYes, 'isNo:', isNo);

        if (isYes) {
          await pool.query(
            `UPDATE leads
             SET lead_source='realtor_referral',
                 referral_partner='realtor_assist',
                 conv_state=$1,
                 last_seen_at=NOW()
             WHERE from_phone=$2`,
            [STATES.AWAITING_AGENT_NAME, from_phone]
          );
          clearReferralTimeout(from_phone);
          await notifyReferralPartner(from_phone);
          await sendSms(from_phone, "Got it — what's the agent's name or brokerage? (You can skip this by replying SKIP)");
          return;
        }

        if (isNo || bodyUpper === "SKIP") {
          await pool.query(
            `UPDATE leads
             SET lead_source='sms',
                 conv_state=$1,
                 last_seen_at=NOW()
             WHERE from_phone=$2`,
            [STATES.AWAITING_MEDIA, from_phone]
          );
          clearReferralTimeout(from_phone);
          await sendPhotoPrompt(from_phone);
          break;
        }

        await sendSms(from_phone, "Just to confirm — were you referred by a real estate agent or property manager? Reply YES or NO.");
      } catch (_) {
        clearReferralTimeout(from_phone);
        setState(from_phone, STATES.AWAITING_MEDIA);
        await sendPhotoPrompt(from_phone);
      }
      break;
    }

    case STATES.AWAITING_AGENT_NAME: {
      try {
        const agentInput = String(body || "").trim();
        if (/^skip$/i.test(agentInput)) {
          await pool.query(
            "UPDATE leads SET conv_state=$1, last_seen_at=NOW() WHERE from_phone=$2",
            [STATES.AWAITING_MEDIA, from_phone]
          );
          await sendPhotoPrompt(from_phone);
          break;
        }
        if (!agentInput) {
          await sendSms(from_phone, "Got it — what's the agent's name or brokerage? (You can skip this by replying SKIP)");
          break;
        }
        await pool.query(
          "UPDATE leads SET referral_agent_name=$1, conv_state=$2, last_seen_at=NOW() WHERE from_phone=$3",
          [agentInput.slice(0, 140), STATES.AWAITING_MEDIA, from_phone]
        );
        await sendPhotoPrompt(from_phone);
      } catch (_) {
        setState(from_phone, STATES.AWAITING_MEDIA);
        await sendPhotoPrompt(from_phone);
      }
      break;
    }

    case STATES.AWAITING_POST_PAYMENT_REFERRAL: {
      console.warn(`[deprecated state] lead ${lead?.id || from_phone} in AWAITING_POST_PAYMENT_REFERRAL — migrating to BOOKING_SENT`);
      await pool.query(
        "UPDATE leads SET conv_state=$1, quote_status='BOOKING_SENT', last_seen_at=NOW() WHERE from_phone=$2",
        [STATES.BOOKING_SENT, from_phone]
      );
      const migratedLead = await getLead.get(from_phone);
      await sendDayPickerPrompt(from_phone, migratedLead || lead);
      break;
    }

    case STATES.AWAITING_MEDIA: {
      const isVideo = (payload.MediaContentType0||"").includes("video");
      if (isVideo) { await sendSms(from_phone, "Got it! Videos don't come through our system — can you send still photos instead? Different angles help us give you the most accurate quote."); break; }
      if (numMedia>0||mediaUrl) {
        try { upsertLead.run({from_phone,to_phone,ts:new Date().toISOString(),last_event:"media_received",last_body:body,num_media:numMedia,media_url0:mediaUrl||null}); } catch(e){}
        logEvent(from_phone,"media_received",{numMedia,mediaUrl});
        setState(from_phone,STATES.AWAITING_HAZMAT);
        pool.query(
          `UPDATE leads
           SET has_media=1,
               load_bucket=NULL,
               access_level=NULL,
               customer_load_bucket=NULL,
               customer_access_level=NULL,
               quote_ready=0,
               quote_status=NULL,
               square_payment_link_id=NULL,
               square_payment_link_url=NULL,
               square_order_id=NULL,
               square_upfront_payment_link_id=NULL,
               square_upfront_payment_link_url=NULL,
               square_upfront_order_id=NULL,
               square_payment_id=NULL,
               deposit_paid=0,
               deposit_paid_at=NULL,
               quote_total_cents=NULL,
               upfront_total_cents=NULL,
               upfront_discount_pct=NULL,
               low_confidence_retry=0,
               conv_state=$1,
               last_seen_at=NOW()
           WHERE from_phone=$2`,
          [STATES.AWAITING_HAZMAT, from_phone]
        ).catch(()=>{});
        if (allMediaUrls.length>0) runVisionAsync(from_phone, allMediaUrls[0], allMediaUrls);
        await sendSms(from_phone,"Got it — quick safety check: any paint, chemicals, fuel, batteries, asbestos, or medical waste in the mix?\n\nReply YES or NO");
      } else {
        setState(from_phone,STATES.AWAITING_MEDIA);
        backfillLatestMedia({from:from_phone,maxAgeSeconds:120}).then((b)=>{
          if (b&&b.mediaUrl0) {
            pool.query(
              `UPDATE leads
               SET has_media=1,
                   num_media=$1,
                   media_url0=$2,
                   load_bucket=NULL,
                   access_level=NULL,
                   customer_load_bucket=NULL,
                   customer_access_level=NULL,
                   quote_ready=0,
                   quote_status=NULL,
                   square_payment_link_id=NULL,
                   square_payment_link_url=NULL,
                   square_order_id=NULL,
                   square_upfront_payment_link_id=NULL,
                   square_upfront_payment_link_url=NULL,
                   square_upfront_order_id=NULL,
                   square_payment_id=NULL,
                   deposit_paid=0,
                   deposit_paid_at=NULL,
                   quote_total_cents=NULL,
                   upfront_total_cents=NULL,
                   upfront_discount_pct=NULL,
                   low_confidence_retry=0,
                   conv_state=$3,
                   last_seen_at=NOW()
               WHERE from_phone=$4`,
              [b.numMedia,b.mediaUrl0,STATES.AWAITING_HAZMAT,from_phone]
            ).catch(()=>{});
            setState(from_phone,STATES.AWAITING_HAZMAT);
            logEvent(from_phone,"media_backfill_hit",b);
            runVisionAsync(from_phone,b.mediaUrl0,[b.mediaUrl0]);
            sendSms(from_phone,"Got it — quick safety check: any paint, chemicals, fuel, batteries, asbestos, or medical waste?\n\nReply YES or NO").catch(()=>{});
          } else {
            pool.query("SELECT COUNT(*) as cnt FROM events WHERE from_phone=$1", [from_phone]).then(evtR => {
              const isCaller = parseInt(evtR.rows[0].cnt) <= 1;
              const msg = isCaller
                ? "Hey! You just called us — glad you reached out. Go ahead and send up to 10 photos of what needs to go — different angles help us give you the most accurate quote. 📦\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote."
                : "Hi! Thanks for texting ICL Junk Removal.\n\nSend us up to 10 photos of what you need removed — different angles help us give you the most accurate quote.\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote.";
              sendSms(from_phone, msg).then(() => {
            }).catch(()=>{});
            }).catch(()=>{ sendSms(from_phone,"Hi! Thanks for texting ICL Junk Removal.\n\nSend us up to 10 photos of what you need removed — different angles help us give you the most accurate quote.\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote.").catch(()=>{}); });
          }
        }).catch(()=>{ sendSms(from_phone,"Hi! Thanks for texting ICL Junk Removal.\n\nSend us up to 10 photos of what you need removed — different angles help us give you the most accurate quote.\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote.").catch(()=>{}); });
      }
      break;
    }

    case STATES.AWAITING_HAZMAT: {
      if (numMedia>0||mediaUrl) { if(allMediaUrls.length>0) runVisionAsync(from_phone,allMediaUrls[0],allMediaUrls); await sendSms(from_phone,"Got your photos! Any paint, chemicals, fuel, batteries, asbestos, or medical waste?\n\nReply YES or NO"); break; }
      if (bodyUpper==="YES") {
        logEvent(from_phone,"hazmat_yes",{body});
        const escalated = await escalateLead(from_phone, "hazmat_confirmed_yes", lead);
        if (!escalated) {
          setState(from_phone,STATES.ESCALATED);
          await sendSms(from_phone,"Thanks for the heads up — restricted materials need special handling. A team member will reach out to discuss options.");
        }
      } else if (bodyUpper.startsWith("NO")||bodyUpper==="N") {
        logEvent(from_phone,"hazmat_no",{body});
        if (isPath1Lead(lead) && String(lead?.address_text || "").trim()) {
          await pool.query(
            `UPDATE leads
             SET access_level='ALL_AREAS',
                 customer_access_level='ALL_AREAS',
                 conv_state=$1,
                 quote_status='READY',
                 quote_ready=1,
                 last_seen_at=NOW()
             WHERE from_phone=$2`,
            [STATES.AWAITING_ADDON_SELECTION, from_phone]
          );
          await sendSms(from_phone, PATH1_ADDON_PROMPT);
          scheduleAddonOfferTimeout(from_phone);
        } else {
          setState(from_phone,STATES.AWAITING_ADDRESS);
          await sendSms(from_phone,"What's the service address? Cross streets + ZIP works too.");
        }
      } else {
        await sendSms(from_phone,"Reply YES or NO — any restricted materials like paint, chemicals, or medical waste?");
      }
      break;
    }

    case STATES.AWAITING_ADDRESS: {
      if (body.length<3) { await sendSms(from_phone,"Please send the service address or nearest cross streets + ZIP."); break; }
      const zipMatch=body.match(/\b(\d{5})\b/); const zip=zipMatch?zipMatch[1]:null;
      await pool.query('UPDATE leads SET address_text=$1,zip=$2,zip_text=$2,last_seen_at=NOW() WHERE from_phone=$3', [body,zip,from_phone]);
      logEvent(from_phone,"address_capture",{address:body,zip});
      if (isPath1Lead(lead)) {
        setState(from_phone, STATES.AWAITING_ADDRESS_CONFIRM);
        await sendSms(from_phone, "Got it: " + body + ". Is that right? Reply YES or NO.");
      } else {
        await sendSms(from_phone, "Excellent — we have " + body + " confirmed. We're preparing your quote now.");
        await advanceAfterAddress(from_phone);
      }
      break;
    }

    case STATES.AWAITING_ADDRESS_CONFIRM: {
      if (bodyUpper === "YES" || bodyUpper === "Y") {
        setState(from_phone, STATES.AWAITING_HAZMAT);
        await sendSms(from_phone, "Quick safety check: any paint, chemicals, fuel, batteries, asbestos, or medical waste on site? Reply YES or NO.");
        break;
      }
      if (bodyUpper === "NO" || bodyUpper === "N") {
        setState(from_phone, STATES.AWAITING_ADDRESS);
        await sendSms(from_phone, "No problem — please resend the property address (street, city, state).");
        break;
      }
      await sendSms(from_phone, "Please reply YES or NO so we can confirm the address.");
      break;
    }

    case STATES.AWAITING_ACCESS: {
      let accessLevel=null;
      const path1 = isPath1Lead(lead);
      if (path1) {
        if (/\b1\b/.test(bodyUpper) || bodyUpper.includes("INSIDE")) accessLevel = "INSIDE_HOME";
        else if (/\b2\b/.test(bodyUpper) || bodyUpper.includes("GARAGE")) accessLevel = "GARAGE";
        else if (/\b3\b/.test(bodyUpper) || bodyUpper.includes("CURB")) accessLevel = "CURB";
        else if (/\b4\b/.test(bodyUpper) || bodyUpper.includes("MIX")) accessLevel = "OTHER";
      }
      for(const [key,val] of Object.entries(ACCESS_MAP)){if(bodyUpper.includes(key)){accessLevel=val;break;}}
      if (!accessLevel) {
        if (path1) await sendSms(from_phone, PATH1_ACCESS_PROMPT);
        else await sendSms(from_phone,"Reply with: CURB / DRIVEWAY / GARAGE / INSIDE HOME / STAIRS / APARTMENT / OTHER");
        break;
      }
      await pool.query("UPDATE leads SET access_level=$1, customer_access_level=$1, last_seen_at=NOW() WHERE from_phone=$2", [accessLevel, from_phone]);
      logEvent(from_phone,"access_capture",{access_level:accessLevel});
      if (path1) {
        await pool.query(
          "UPDATE leads SET conv_state=$1, quote_status='READY', quote_ready=1, last_seen_at=NOW() WHERE from_phone=$2",
          [STATES.AWAITING_ADDON_SELECTION, from_phone]
        );
        await sendSms(from_phone, PATH1_ADDON_PROMPT);
        scheduleAddonOfferTimeout(from_phone);
        break;
      }
      const afterAccess=await getLead.get(from_phone);
      const autoQuoted = await maybeAutoQuoteFromVision(from_phone, "after_access");
      if (autoQuoted) break;
      setState(from_phone,STATES.AWAITING_LOAD);
      await sendLoadPrompt(from_phone, afterAccess);
      break;
    }

    case STATES.AWAITING_LOAD: {
      let loadBucket=null;
      for(const [key,val] of Object.entries(LOAD_MAP)){if(bodyUpper.includes(key)){loadBucket=val;break;}}
      if (!loadBucket) { await sendSms(from_phone,"Reply SMALL, MEDIUM, or LARGE."); break; }
      await pool.query("UPDATE leads SET load_bucket=$1, customer_load_bucket=$1, conv_state=$2, last_seen_at=NOW() WHERE from_phone=$3", [loadBucket, STATES.QUOTE_READY, from_phone]);
      logEvent(from_phone,"load_capture",{load_bucket:loadBucket});
      await triggerQuote(from_phone);
      break;
    }

    case STATES.AWAITING_DEPOSIT: {
      const isRealtorLead = String(lead?.lead_source || "") === "realtor_referral";
      if (isRealtorLead && bodyUpper === "ADD") {
        await sendSms(from_phone, "Your current payment links are already set. We can still add extras on-site if needed.");
        break;
      }
      if (isRealtorLead && bodyUpper === "SKIP") {
        await sendSms(from_phone, "Perfect — you're all set with the current quote. Reply RESEND if you need your checkout links again.");
        break;
      }
      let loadBucket=null;
      for(const [key,val] of Object.entries(LOAD_MAP)){if(bodyUpper.includes(key)){loadBucket=val;break;}}
      if (loadBucket) {
        await pool.query(
          "UPDATE leads SET load_bucket=$1, customer_load_bucket=$1, conv_state=$2, quote_status='READY', quote_ready=1, square_payment_link_id=NULL, square_payment_link_url=NULL, square_order_id=NULL, square_upfront_payment_link_id=NULL, square_upfront_payment_link_url=NULL, square_upfront_order_id=NULL, quote_total_cents=NULL, upfront_total_cents=NULL, upfront_discount_pct=NULL, last_seen_at=NOW() WHERE from_phone=$3",
          [loadBucket, STATES.QUOTE_READY, from_phone]
        );
        logEvent(from_phone, "load_adjust_before_deposit", { load_bucket: loadBucket });
        await sendSms(from_phone, "Updated — rebuilding your quote with that load size now.");
        await triggerQuote(from_phone);
        break;
      }
      await sendSms(from_phone,"Your checkout links are ready — use either the $50 deposit or upfront-save option to lock your arrival window. Reply HELP if you need links resent.");
      break;
    }

    case STATES.AWAITING_ADDON_SELECTION: {
      try {
        clearAddonOfferTimeout(from_phone);
        const dynamic = getDynamicAddonPricing(lead || {});
        const selectionPrompt =
          "Which would you like to add?\n\n" +
          "1) Deep Clean — $" + dynamic.deepCleanDollars + "\n" +
          "2) Pressure Wash — $" + dynamic.pressureWashDollars + "\n" +
          "3) Paint Touch-Ups — $" + dynamic.paintTouchupDollars + "\n" +
          "4) Minor Repairs — priced on-site\n\n" +
          "Reply the number(s). Example: reply 1 3 to add both.";

        if (bodyUpper === "YES") {
          if (isPath1Lead(lead)) await sendSms(from_phone, PATH1_ADDON_PROMPT);
          else await sendSms(from_phone, selectionPrompt);
          scheduleAddonOfferTimeout(from_phone);
          break;
        }

        if (bodyUpper === "SKIP") {
          await pool.query(
            `UPDATE leads
             SET prelisting_addons=$1,
                 prelisting_addon_total_cents=0,
                 addon_deep_clean_cents=0,
                 addon_pressure_wash_cents=0,
                 addon_paint_touchup_cents=0,
                 conv_state=$2,
                 quote_status='READY',
                 quote_ready=1,
                 square_payment_link_id=NULL,
                 square_payment_link_url=NULL,
                 square_order_id=NULL,
                 square_upfront_payment_link_id=NULL,
                 square_upfront_payment_link_url=NULL,
                 square_upfront_order_id=NULL,
                 quote_total_cents=NULL,
                 upfront_total_cents=NULL,
                 upfront_discount_pct=NULL,
                 last_seen_at=NOW()
             WHERE from_phone=$3`,
            [JSON.stringify([]), STATES.QUOTE_READY, from_phone]
          );
          if (isPath1Lead(lead)) {
            const path1Quote = await maybeCreateQuote(from_phone);
            if (!path1Quote?.ok) logEvent(from_phone, "path1_quote_failed_after_skip", path1Quote || {});
          } else {
            await triggerQuote(from_phone);
          }
          break;
        }

        const matches = (body.match(/\b[1-4]\b/g) || []).map((v) => Number(v));
        const unique = [...new Set(matches)].filter((n) => REALTOR_ADDON_CODE_MAP[n]);
        if (!unique.length) {
          if (isPath1Lead(lead)) {
            await sendSms(from_phone, "Reply with add-on number(s) like 1 3, or reply SKIP to continue.");
          } else {
            await sendSms(from_phone, "Reply YES to see service options, or SKIP to continue with your quote.");
          }
          scheduleAddonOfferTimeout(from_phone);
          break;
        }

        const addons = unique.map((n) => {
          if (n === 1) return { code: "DEEP_CLEAN", label: "Deep Clean", cents: dynamic.deepCleanCents };
          if (n === 2) return { code: "PRESSURE_WASH", label: "Pressure Wash", cents: dynamic.pressureWashCents };
          if (n === 3) return { code: "PAINT_TOUCHUP", label: "Paint Touch-Ups", cents: dynamic.paintTouchupCents };
          return { code: "MINOR_REPAIRS", label: "Minor Repairs (on-site quote)", cents: null };
        });
        const addonDeepCleanCents = addons.find((a) => a.code === "DEEP_CLEAN")?.cents || 0;
        const addonPressureWashCents = addons.find((a) => a.code === "PRESSURE_WASH")?.cents || 0;
        const addonPaintTouchupCents = addons.find((a) => a.code === "PAINT_TOUCHUP")?.cents || 0;
        const addonTotalCents = addonDeepCleanCents + addonPressureWashCents + addonPaintTouchupCents;
        const existingAddonTotal = Math.max(0, Math.round(Number(lead?.prelisting_addon_total_cents || 0)));
        const baseQuoteCents = Math.max(0, Math.round(Number(lead?.quote_total_cents || 0)) - existingAddonTotal);
        const updatedTotalCents = baseQuoteCents + addonTotalCents;

        await pool.query(
          `UPDATE leads
           SET prelisting_addons=$1,
               prelisting_addon_total_cents=$2,
               addon_deep_clean_cents=$3,
               addon_pressure_wash_cents=$4,
               addon_paint_touchup_cents=$5,
               conv_state=$6,
               quote_status='READY',
               quote_ready=1,
               square_payment_link_id=NULL,
               square_payment_link_url=NULL,
               square_order_id=NULL,
               square_upfront_payment_link_id=NULL,
               square_upfront_payment_link_url=NULL,
               square_upfront_order_id=NULL,
               quote_total_cents=NULL,
               upfront_total_cents=NULL,
               upfront_discount_pct=NULL,
               last_seen_at=NOW()
           WHERE from_phone=$7`,
          [
            JSON.stringify(addons),
            addonTotalCents,
            addonDeepCleanCents,
            addonPressureWashCents,
            addonPaintTouchupCents,
            STATES.QUOTE_READY,
            from_phone
          ]
        );
        logEvent(from_phone, "prelisting_addons_selected", {
          addons,
          prelisting_addon_total_cents: addonTotalCents,
          addon_sqft: dynamic.sqft,
        });
        if (isPath1Lead(lead)) {
          const path1Quote = await maybeCreateQuote(from_phone);
          if (!path1Quote?.ok) logEvent(from_phone, "path1_quote_failed_after_addons", path1Quote || {});
        } else {
          await triggerQuote(from_phone);
        }
      } catch (_) {
        await pool.query(
          "UPDATE leads SET prelisting_addons=$1, prelisting_addon_total_cents=0, addon_deep_clean_cents=0, addon_pressure_wash_cents=0, addon_paint_touchup_cents=0, conv_state=$2, quote_status='READY', quote_ready=1, last_seen_at=NOW() WHERE from_phone=$3",
          [JSON.stringify([]), STATES.QUOTE_READY, from_phone]
        ).catch(()=>{});
        clearAddonOfferTimeout(from_phone);
        if (isPath1Lead(lead)) {
          const path1Quote = await maybeCreateQuote(from_phone);
          if (!path1Quote?.ok) logEvent(from_phone, "path1_quote_failed_after_addons_fallback", path1Quote || {});
        } else {
          await triggerQuote(from_phone);
        }
      }
      break;
    }

    case STATES.BOOKING_SENT: {
      const dayOptions = readDayOptionsSnapshot(lead);
      const idx = Number.parseInt(String(body || "").trim(), 10) - 1;
      if (!Number.isFinite(idx) || idx < 0 || idx >= dayOptions.length) {
        await sendSms(from_phone, "Please reply 1, 2, or 3:\n\n" + formatDayPickerMenu(dayOptions));
        break;
      }
      const chosenDay = dayOptions[idx];
      await pool.query(
        "UPDATE leads SET timing_pref=$1, conv_state=$2, quote_status='BOOKING_SENT', last_seen_at=NOW() WHERE from_phone=$3",
        [chosenDay, STATES.AWAITING_DAY, from_phone]
      );
      logEvent(from_phone, "booking_day_selected", { selected_day: chosenDay, index: idx + 1, day_options: dayOptions });
      await sendAfterDayWindowPrompt(from_phone);
      break;
    }

    case STATES.AWAITING_DAY: {
      let selectedWindow = null;
      for (const [key, val] of Object.entries(AFTER_DAY_WINDOW_MAP)) {
        if (bodyUpper.includes(key)) { selectedWindow = val; break; }
      }
      if (!selectedWindow) {
        await sendAfterDayWindowPrompt(from_phone);
        break;
      }
      const chosenDay = String(lead?.timing_pref || "").trim() || "your selected day";
      const fullTiming = chosenDay + ", " + selectedWindow;
      await pool.query(
        "UPDATE leads SET timing_pref=$1, conv_state=$2, quote_status='BOOKING_SENT', last_seen_at=NOW() WHERE from_phone=$3",
        [fullTiming, STATES.AWAITING_POST_BOOKING_REFERRAL, from_phone]
      );
      logEvent(from_phone,"window_selected_after_day",{timing_pref:fullTiming});
      const updatedLead = (await pool.query('SELECT * FROM leads WHERE from_phone=$1',[from_phone])).rows[0];
      createJobEvent(updatedLead).catch(e=>console.error('[calendar] event error:',e));
      await sendSms(
        from_phone,
        "Booked — " + fullTiming + " window.\n\n" +
        "One last thing — were you referred by an agent? Reply their name or SKIP."
      );
      break;
    }

    case STATES.WINDOW_SELECTED: {
      await sendSms(from_phone,`You're all set — ${lead&&lead.timing_pref?lead.timing_pref:"arrival confirmed"}. Reply HELP if anything changes.`);
      break;
    }

    case STATES.AWAITING_POST_BOOKING_REFERRAL: {
      const answer = String(body || "").trim();
      const formattedDay = String(lead?.timing_pref || "").split(",")[0]?.trim() || "your scheduled day";
      const isSkip = /^skip$/i.test(answer) || /^no$/i.test(answer) || /^none$/i.test(answer);

      if (isSkip) {
        await pool.query(
          "UPDATE leads SET conv_state=$1, quote_status='BOOKING_CONFIRMED', last_seen_at=NOW() WHERE from_phone=$2",
          [STATES.WINDOW_SELECTED, from_phone]
        );
        await sendSms(from_phone, `All set. We'll see you on ${formattedDay}.`);
        break;
      }

      if (!answer) {
        await sendSms(from_phone, "Reply their name, or SKIP if there was no referral.");
        break;
      }

      await pool.query(
        `UPDATE leads
         SET referral_agent_name=$1,
             lead_source='realtor_referral',
             referral_partner='realtor_assist',
             conv_state=$2,
             quote_status='BOOKING_CONFIRMED',
             last_seen_at=NOW()
         WHERE from_phone=$3`,
        [answer.slice(0, 140), STATES.WINDOW_SELECTED, from_phone]
      );
      await notifyReferralPartner(from_phone);
      await sendSms(from_phone, `Got it — we'll make sure ${answer.slice(0, 140)} gets credit. See you on ${formattedDay}.`);
      break;
    }

    case STATES.ESCALATED: {
      if (numMedia > 0 || mediaUrl) {
        setState(from_phone, STATES.AWAITING_MEDIA);
        if (allMediaUrls.length > 0) runVisionAsync(from_phone, allMediaUrls[0], allMediaUrls);
        await sendSms(from_phone, "Got your photo — analyzing now. We'll follow up with next steps soon.");
        break;
      }
      if (bodyUpper === "HELP") {
        await sendSms(from_phone, "A team member will be in touch shortly. You can also call 855-578-5014.");
        await sendSms("+12138806318", "HELP FOLLOW-UP\nPhone: " + from_phone + "\nCall them back ASAP.");
        break;
      }
      await sendSms(from_phone, "We're here! You can:\n\nSend a photo to get a quote\nCall 855-578-5014\nReply HELP to reach our team");
      break;
    }

    default: {
      setState(from_phone,STATES.NEW);
      // Check if caller followup
    try {
      const evtCheck2 = await pool.query("SELECT COUNT(*) as cnt FROM events WHERE from_phone=$1", [from_phone]);
      const isCallerFollowup2 = parseInt(evtCheck2.rows[0].cnt) <= 1;
      const greeting2 = isCallerFollowup2
        ? "Hey! You just called us — glad you reached out. Go ahead and send up to 10 photos of what needs to go — different angles help us give you the most accurate quote. 📦\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote."
        : "Hi! Thanks for texting ICL Junk Removal. Send us up to 10 photos of what needs to go — different angles help us give you the most accurate quote.\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote.";
      await sendSms(from_phone, greeting2);
    } catch(e) {
      await sendSms(from_phone,"Hi! Thanks for texting ICL Junk Removal. Send us up to 10 photos of what needs to go — different angles help us give you the most accurate quote.\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote.");
    }
    }
  }
}

module.exports = { handleConversation, STATES };
