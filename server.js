const { checkDropoffs } = require("./dropoff_monitor");
const { handleOpsReply } = require("./job_complete");
const { handleSquareWebhook } = require("./square_webhook");
const { fetchLatest } = require("./twilio_debug");
const { backfillLatestMedia } = require("./twilio_media_backfill");
const { recomputeDerived } = require("./recompute");
const { handleWindowReply } = require("./window_reply");
const { evaluateQuoteReadyRow } = require("./quote_gate");
const { handleConversation } = require("./conversation");
const { listWorldviewLeads } = require("./worldview_intel");
const { parseBookingToken } = require("./booking_link");
const { createJobEvent } = require("./calendar");
const { sendSms } = require("./twilio_sms");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { db, pool, upsertLead, insertEvent, getLead } = require("./db");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const BASE_LOCATION = "506 E Brett St, Inglewood, CA 90301";
const BASE_COORD = { lat: 33.9776848, lng: -118.3523303 };
const ZIP_CENTROIDS = {
  "90008": { lat: 34.011, lng: -118.336 },
  "90043": { lat: 33.985, lng: -118.343 },
  "90016": { lat: 34.03, lng: -118.352 },
  "90056": { lat: 33.989, lng: -118.372 },
  "90301": { lat: 33.956, lng: -118.401 },
  "90302": { lat: 33.977, lng: -118.355 },
  "90047": { lat: 33.956, lng: -118.311 },
  "90044": { lat: 33.954, lng: -118.29 }
};
const LEAD_GEO_CACHE = new Map();
const DASHBOARD_DUMPSITES_FALLBACK = [
  {
    id: "south_gate_lacsd",
    name: "South Gate Transfer Station (LACSD)",
    kind: "transfer",
    tier: "primary",
    status: "open",
    lat: 33.9441529,
    lng: -118.1663537,
    msw: true,
    accepts: "MSW, inert waste",
    hours_text: "Mon-Sat 6:00 AM-4:30 PM · Sun closed",
    notes: "ICL default site"
  },
  {
    id: "compton_republic",
    name: "Republic Compton Transfer",
    kind: "transfer",
    tier: "primary",
    status: "open",
    lat: 33.9033397,
    lng: -118.2443543,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Mon-Fri 6:00 AM-5:30 PM · Sat/Sun closed",
    notes: "Good backup"
  },
  {
    id: "american_waste_gardena",
    name: "American Waste Transfer (Republic)",
    kind: "transfer",
    tier: "nearby",
    status: "open",
    lat: 33.9020035,
    lng: -118.301722,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Mon 5:00 AM-5:30 PM · Sat 5:00 AM-4:00 PM",
    notes: "Early open"
  },
  {
    id: "wm_south_gate",
    name: "WM South Gate Transfer",
    kind: "transfer",
    tier: "regional",
    status: "open",
    lat: 33.9577384,
    lng: -118.1904151,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Mon-Sat 8:00 AM-5:00 PM",
    notes: "Secondary South Gate option"
  },
  {
    id: "sunshine_canyon",
    name: "Sunshine Canyon Landfill",
    kind: "landfill",
    tier: "regional",
    status: "open",
    lat: 34.3032234,
    lng: -118.4644237,
    msw: true,
    accepts: "MSW, C&D, green waste, tires, dirt",
    hours_text: "Mon-Fri 6:00 AM-6:00 PM · Sat 7:00 AM-12:00 PM",
    notes: "Long haul backup landfill"
  }
];

function resolveBuildInfo() {
  const envSha = String(
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    ""
  ).trim();
  const envBranch = String(
    process.env.RAILWAY_GIT_BRANCH ||
    process.env.RENDER_GIT_BRANCH ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    ""
  ).trim();
  if (envSha) {
    return {
      sha: envSha,
      sha_short: envSha.slice(0, 7),
      branch: envBranch || null,
      source: "env"
    };
  }
  try {
    const sha = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
    return {
      sha,
      sha_short: sha.slice(0, 7),
      branch: branch || null,
      source: "git"
    };
  } catch {
    return { sha: null, sha_short: "unknown", branch: null, source: "unknown" };
  }
}
const BUILD_INFO = resolveBuildInfo();

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function geocodeOSM(q) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", q);
  const r = await fetch(url.toString(), { headers: { "User-Agent": "ICL-Twilio-Intake/1.0" }});
  const j = await r.json();
  if (!Array.isArray(j) || j.length === 0) return null;
  return { lat: Number(j[0].lat), lon: Number(j[0].lon), display: j[0].display_name };
}

function toIsoMaybe(v) {
  if (!v) return null;
  const d = new Date(v);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return d.toISOString();
}

function toMinAgeSince(tsIso) {
  const ts = tsIso ? new Date(tsIso).getTime() : NaN;
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.floor((Date.now() - ts) / 60000));
}

function leadState(lead) {
  return String(lead?.conv_state || lead?.quote_status || "NEW");
}

function flowBucketFromState(state) {
  const u = String(state || "").toUpperCase();
  if (u.includes("WINDOW") || u.includes("DAY") || u.includes("BOOKING") || u.includes("COMPLETED")) return "booked";
  if (u.includes("DEPOSIT")) return "deposit";
  if (u.includes("QUOTE")) return "quoted";
  if (u.includes("MEDIA")) return "media";
  return "new";
}

function stageFromLead(lead) {
  if (Number(lead?.deposit_paid) === 1) return "green";
  const flow = flowBucketFromState(leadState(lead));
  if (flow === "quoted" || flow === "deposit" || flow === "booked") return "yellow";
  return "red";
}

function stageLabel(stage) {
  if (stage === "green") return "Completed / review";
  if (stage === "yellow") return "Deposit paid";
  return "Lead (pre-deposit)";
}

function riskFromInactivity(minutes) {
  if (minutes >= 120) return "high";
  if (minutes >= 45) return "medium";
  return "low";
}

function extractZipFromLead(lead) {
  const z1 = String(lead?.zip || "").trim();
  if (/^\d{5}$/.test(z1)) return z1;
  const z2 = String(lead?.zip_text || "").trim();
  if (/^\d{5}$/.test(z2)) return z2;
  const addr = String(lead?.address_text || "").trim();
  const m = addr.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

function cachedLeadGeo(cacheKey) {
  const rec = LEAD_GEO_CACHE.get(cacheKey);
  if (!rec) return null;
  if (!Number.isFinite(Number(rec.lat)) || !Number.isFinite(Number(rec.lng))) return null;
  return { lat: Number(rec.lat), lng: Number(rec.lng), source: String(rec.source || "cache") };
}

async function resolveLeadCoordinates(lead, { allowGeocode = true } = {}) {
  const phone = String(lead?.from_phone || lead?.phone || "");
  const address = String(lead?.address_text || "").trim();
  const zip = extractZipFromLead(lead);
  const cacheKey = `${phone}|${address}|${zip}`;
  const fromCache = cachedLeadGeo(cacheKey);
  if (fromCache) return fromCache;

  if (allowGeocode && address.length >= 6) {
    try {
      const q = `${address}${zip ? ` ${zip}` : ""} Los Angeles CA`;
      const geo = await geocodeOSM(q);
      if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
        const out = { lat: Number(geo.lat), lng: Number(geo.lon), source: "osm" };
        LEAD_GEO_CACHE.set(cacheKey, out);
        return out;
      }
    } catch {}
  }

  if (zip && ZIP_CENTROIDS[zip]) {
    const out = { lat: ZIP_CENTROIDS[zip].lat, lng: ZIP_CENTROIDS[zip].lng, source: "zip_fallback" };
    LEAD_GEO_CACHE.set(cacheKey, out);
    return out;
  }
  return null;
}

function isFutureIso(raw) {
  if (!raw) return true;
  const dt = new Date(String(raw));
  const ts = dt.getTime();
  if (!Number.isFinite(ts)) return true;
  return ts > Date.now();
}

function applyDumpSiteOverrides(baseSites, rows) {
  if (!Array.isArray(baseSites) || !baseSites.length || !Array.isArray(rows) || !rows.length) {
    return { sites: baseSites || [], overrideCount: 0 };
  }
  const byId = new Map(baseSites.map((s) => [String(s.id || ""), { ...s }]));
  let overrideCount = 0;
  for (const r of rows) {
    const id = String(r.site_id || "").trim();
    if (!id || !byId.has(id)) continue;
    if (!isFutureIso(r.active_until)) continue;
    const cur = byId.get(id);
    if (r.status_override) cur.status = String(r.status_override).toLowerCase();
    if (r.notes_override) cur.notes = String(r.notes_override);
    if (r.priority_override != null && Number.isFinite(Number(r.priority_override))) {
      cur.priority = Number(r.priority_override);
    }
    overrideCount += 1;
  }
  return { sites: Array.from(byId.values()), overrideCount };
}

const app = express();
app.use("/public", require("express").static(require("path").join(__dirname, "public")));
app.use(express.json({ limit: "2mb" }))
function paymentLandingHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ICL Payment Confirmed</title>
  <style>
    body{margin:0;background:#f8fafc;color:#0f172a;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:18px}
    .card{max-width:640px;margin:32px auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 8px 26px rgba(2,6,23,.08);overflow:hidden}
    .hero{background:linear-gradient(135deg,#0f766e,#134e4a);color:#f0fdfa;padding:18px 20px}
    .hero h1{margin:0 0 4px;font-size:24px}
    .hero p{margin:0;color:#ccfbf1}
    .body{padding:18px 20px}
    .ok{display:inline-block;background:#dcfce7;border:1px solid #16a34a;color:#166534;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:700}
    .small{font-size:13px;color:#475569}
  </style>
</head>
<body>
  <div class="card">
    <div class="hero">
      <h1>Payment received ✅</h1>
      <p>ICL Junk Removal</p>
    </div>
    <div class="body">
      <div class="ok">Confirmed</div>
      <p>Thanks — your payment went through.</p>
      <p class="small">You’ll receive (or may have already received) a confirmation SMS with your scheduling step and confirmation number.</p>
      <p class="small">If you don’t see the text within a minute, reply to our SMS thread and we’ll help right away.</p>
    </div>
  </div>
</body>
</html>`;
}

app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).end(paymentLandingHtml());
});
app.get("/thanks", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).end(paymentLandingHtml());
});
app.get("/thank-you", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).end(paymentLandingHtml());
});
app.get("/payment-success", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).end(paymentLandingHtml());
});
app.get("/payment/confirmed", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).end(paymentLandingHtml());
});
// Territory dashboard
app.get('/dashboard', (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
;
app.get("/api/version", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  return res.json({
    ok: true,
    build: BUILD_INFO,
    served_at: new Date().toISOString()
  });
});
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
app.use("/admin", (req, res, next) => {
  if (!ADMIN_PASSWORD) return res.status(500).send("Admin password not set.");
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="ICL Admin"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
  const pass = decoded.split(":").slice(1).join(":");
  if (pass !== ADMIN_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="ICL Admin"');
    return res.status(401).send("Bad credentials");
  }
  next();
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 8788;
const BASE_DIR = path.join(process.env.HOME || ".", "secrets", "twilio-intake-logs");
const LEADS_DIR = path.join(BASE_DIR, "leads");
fs.mkdirSync(BASE_DIR, { recursive: true });
fs.mkdirSync(LEADS_DIR, { recursive: true });
const BOOKING_WINDOWS = ["8-10am", "10-12pm", "12-2pm", "2-4pm", "4-6pm"];

let baseGeo = null;

function safeFilenameFromPhone(phone) {
  return String(phone || "unknown").replace(/[^0-9+]/g, "_");
}

function upsertLeadFile(from, patch) {
  const fn = safeFilenameFromPhone(from) + ".json";
  const fp = path.join(LEADS_DIR, fn);
  let cur = {};
  if (fs.existsSync(fp)) {
    try { cur = JSON.parse(fs.readFileSync(fp, "utf8")); } catch {}
  }
  const next = {
    ...cur,
    ...patch,
    _meta: { ...(cur._meta || {}), updatedAt: new Date().toISOString(), from },
  };
  fs.writeFileSync(fp, JSON.stringify(next, null, 2), { mode: 0o600 });
  return fp;
}

function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabelFromIso(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (!Number.isFinite(dt.getTime())) return null;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][dt.getUTCMonth()];
  return `${dow} ${mon} ${dt.getUTCDate()}`;
}

function bookingDayOptions(days = 7) {
  const now = new Date();
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const iso = toIsoDate(d);
    const label = dayLabelFromIso(iso);
    if (!label) continue;
    out.push({ iso, label });
  }
  return out;
}

async function latestPaymentMetaForPhone(fromPhone) {
  try {
    const row = (
      await pool.query(
        `SELECT event_type, payload_json, created_at
         FROM events
         WHERE from_phone = $1
           AND event_type IN ('deposit_paid', 'upfront_paid')
         ORDER BY id DESC
         LIMIT 1`,
        [fromPhone]
      )
    ).rows[0];
    if (!row) return null;
    let payload = {};
    try { payload = JSON.parse(row.payload_json || "{}"); } catch {}
    return {
      event_type: row.event_type,
      confirmation_id: payload.confirmation_id || null,
      booking_link: payload.booking_link || null,
      created_at: row.created_at || null
    };
  } catch {
    return null;
  }
}

app.post("/square/webhook", handleSquareWebhook);
// Ops reply handler — intercepts texts from business number
app.post("/twilio/ops-reply", async (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
  try {
    const body = req.body.Body || "";
    await handleOpsReply(body);
  } catch(e) {
    console.error("[ops_reply]", e.message);
  }
});

app.get("/api/worldview/leads", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 80);
    const leads = await listWorldviewLeads({ limit });
    return res.json({ ok: true, leads, generated_at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/worldview/lead/:from", async (req, res) => {
  try {
    const from = String(req.params.from || "");
    if (!from) return res.status(400).json({ ok: false, error: "missing from" });
    const leads = await listWorldviewLeads({ limit: 200 });
    const lead = leads.find((l) => String(l.phone) === from);
    if (!lead) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, lead, generated_at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/dashboard/leads", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 120) || 120));
    const geocodeBudget = Math.max(0, Math.min(20, Number(req.query.geocode_budget || 6) || 6));

    const rows = (
      await pool.query(
        `SELECT
           from_phone,
           first_seen_at,
           last_seen_at,
           address_text,
           zip,
           zip_text,
           load_bucket,
           quote_status,
           conv_state,
           deposit_paid,
           timing_pref,
           quote_total_cents,
           has_media,
           num_media
         FROM leads
         ORDER BY last_seen_at DESC NULLS LAST
         LIMIT $1`,
        [limit]
      )
    ).rows;

    const phones = rows.map((r) => String(r.from_phone || "")).filter(Boolean);
    const actionCounts = new Map();
    if (phones.length) {
      try {
        const tracked = ["next_action_sent", "sla_nudge_sent", "dropoff_recovery_sent"];
        const evRows = (
          await pool.query(
            `SELECT from_phone, COUNT(*)::int AS cnt
             FROM events
             WHERE from_phone = ANY($1)
               AND event_type = ANY($2)
             GROUP BY from_phone`,
            [phones, tracked]
          )
        ).rows;
        for (const r of evRows) actionCounts.set(String(r.from_phone || ""), Number(r.cnt || 0));
      } catch {}
    }

    const leads = rows.map((r) => {
      const phone = String(r.from_phone || "");
      const state = leadState(r);
      return {
        phone,
        from_phone: phone,
        state,
        created_at: toIsoMaybe(r.first_seen_at || r.last_seen_at) || new Date().toISOString(),
        last_seen_at: r.last_seen_at || null,
        address: String(r.address_text || ""),
        zip: extractZipFromLead(r),
        load_bucket: r.load_bucket || null,
        quote_status: r.quote_status || null,
        deposit_paid: Number(r.deposit_paid) === 1,
        settled_revenue_cents: null,
        total_cost_cents: null,
        margin_cents: null,
        margin_pct: null,
        next_action_sent_count: Number(actionCounts.get(phone) || 0)
      };
    });

    const pins = [];
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const lead = leads[i];
      const coords = await resolveLeadCoordinates(raw, { allowGeocode: i < geocodeBudget });
      if (!coords) continue;
      const distance = haversineMiles(BASE_COORD.lat, BASE_COORD.lng, Number(coords.lat), Number(coords.lng));
      const inactivityMinutes = toMinAgeSince(toIsoMaybe(raw.last_seen_at || raw.first_seen_at) || null);
      const risk = riskFromInactivity(inactivityMinutes);
      const stage = stageFromLead(raw);
      const stageWeight = stage === "red" ? 90 : stage === "yellow" ? 60 : 30;
      const riskWeight = risk === "high" ? 30 : risk === "medium" ? 15 : 0;
      const priorityScore = stageWeight + riskWeight + Math.min(120, Math.floor(inactivityMinutes / 5));
      pins.push({
        phone: lead.phone,
        address: lead.address,
        zip: lead.zip,
        lat: Number(coords.lat),
        lng: Number(coords.lng),
        stage,
        stage_label: stageLabel(stage),
        conv_state: raw.conv_state || null,
        quote_status: raw.quote_status || null,
        source: coords.source,
        eta_minutes_est: Math.max(5, Math.round(distance * 4)),
        distance_miles_to_base: Math.round(distance * 10) / 10,
        inactivity_minutes: inactivityMinutes,
        risk,
        priority_score: priorityScore
      });
    }

    pins.sort((a, b) => Number(b.priority_score || 0) - Number(a.priority_score || 0));
    const routeSuggestion = [];
    for (let i = 0; i < Math.min(6, pins.length); i++) {
      const p = pins[i];
      const prev = i === 0 ? BASE_COORD : { lat: pins[i - 1].lat, lng: pins[i - 1].lng };
      const legMiles = haversineMiles(prev.lat, prev.lng, Number(p.lat), Number(p.lng));
      routeSuggestion.push({
        stop: i + 1,
        phone: p.phone,
        stage: p.stage,
        stage_label: p.stage_label,
        risk: p.risk,
        eta_minutes_est: p.eta_minutes_est,
        leg_miles: Math.round(legMiles * 10) / 10,
        address: p.address,
        conv_state: p.conv_state,
        traffic_model: "haversine"
      });
    }

    const stageCounts = { red: 0, yellow: 0, green: 0 };
    const riskCounts = { high: 0, medium: 0, low: 0 };
    let etaSum = 0;
    for (const p of pins) {
      if (stageCounts[p.stage] != null) stageCounts[p.stage] += 1;
      if (riskCounts[p.risk] != null) riskCounts[p.risk] += 1;
      etaSum += Number(p.eta_minutes_est || 0);
    }
    const paidCount = leads.filter((l) => l.deposit_paid).length;
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const d = now.getUTCDate();
    const bookedToday = rows.filter((r) => {
      if (!String(r.timing_pref || "").trim()) return false;
      const ts = new Date(r.last_seen_at || r.first_seen_at || 0);
      return ts.getUTCFullYear() === y && ts.getUTCMonth() === m && ts.getUTCDate() === d;
    }).length;
    const slaRedCount = pins.filter((p) => Number(p.inactivity_minutes || 0) >= 120 && p.stage !== "green").length;
    const nextActionsSentTotal = leads.reduce((s, l) => s + Number(l.next_action_sent_count || 0), 0);

    return res.json({
      ok: true,
      leads,
      pins,
      route_suggestion: routeSuggestion,
      meta: {
        total: leads.length,
        pins: pins.length,
        stage_counts: stageCounts,
        risk_counts: riskCounts,
        avg_eta_min: pins.length ? Math.round(etaSum / pins.length) : 0,
        booked_today: bookedToday,
        deposit_rate: leads.length ? Math.round((paidCount / leads.length) * 100) : 0,
        avg_revenue_job: null,
        avg_margin_job: null,
        margin_truth_jobs: 0,
        square_connected: !!(process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID),
        sla_red_count: slaRedCount,
        next_actions_sent_total: nextActionsSentTotal,
        eta_mode: "haversine",
        generated_at: new Date().toISOString()
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/dashboard/dumpsites", async (req, res) => {
  try {
    const filter = String(req.query.filter || "all").trim().toLowerCase();
    let sites = [...DASHBOARD_DUMPSITES_FALLBACK];
    let overrideCount = 0;

    try {
      const rows = (
        await pool.query(
          `SELECT
             site_id,
             status_override,
             notes_override,
             active_until,
             priority_override
           FROM dumpsite_overrides
           WHERE COALESCE(active, 1) = 1`
        )
      ).rows;
      const merged = applyDumpSiteOverrides(sites, rows);
      sites = merged.sites;
      overrideCount = merged.overrideCount;
    } catch {
      // Optional table in older/newer deployments; fallback list remains valid.
    }

    if (filter === "msw") {
      sites = sites.filter((s) => !!s.msw && String(s.status || "").toLowerCase() !== "closed");
    } else if (filter === "open_now" || filter === "open") {
      sites = sites.filter((s) => {
        const st = String(s.status || "").toLowerCase();
        return st === "open" || st === "call";
      });
    }

    return res.json({
      ok: true,
      sites,
      meta: {
        generated_at: new Date().toISOString(),
        source: "server_fallback",
        override_count: overrideCount
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/booking/:token", async (req, res) => {
  try {
    const parsed = parseBookingToken(req.params.token, { maxAgeDays: 30 });
    if (!parsed.ok) return res.status(400).send("Booking link expired. Reply to our SMS for a new link.");
    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone = $1 LIMIT 1", [parsed.phone])).rows[0];
    if (!lead) return res.status(404).send("Lead not found.");
    const paymentMeta = await latestPaymentMetaForPhone(parsed.phone);
    const days = bookingDayOptions(7);
    const dayOptions = days.map((d) => `<option value="${escHtml(d.iso)}">${escHtml(d.label)}</option>`).join("");
    const windowOptions = BOOKING_WINDOWS.map((w) => `<option value="${escHtml(w)}">${escHtml(w)}</option>`).join("");
    const confirmation = paymentMeta?.confirmation_id
      ? `<div class="pill">Confirmation #: <strong>${escHtml(paymentMeta.confirmation_id)}</strong></div>`
      : "";

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ICL Booking</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;padding:18px;color:#0f172a}
    .card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;box-shadow:0 8px 26px rgba(2,6,23,.08)}
    .hero{background:linear-gradient(135deg,#0f766e,#134e4a);padding:18px 20px;color:#f0fdfa}
    .brand{font-size:13px;opacity:.9;letter-spacing:.4px;text-transform:uppercase}
    h1{margin:6px 0 4px;font-size:24px;line-height:1.2}
    .hero p{margin:0;color:#ccfbf1}
    .body{padding:18px 20px}
    p{margin:8px 0;color:#334155}
    .steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0 12px}
    .st{font-size:11px;border:1px solid #cbd5e1;border-radius:999px;padding:6px 8px;text-align:center;background:#fff;color:#334155}
    .st.on{background:#dcfce7;border-color:#16a34a;color:#166534;font-weight:700}
    .st.next{background:#ecfeff;border-color:#22d3ee;color:#155e75;font-weight:600}
    .pill{display:inline-block;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:999px;padding:5px 10px;font-size:12px;color:#334155;margin:6px 0}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0 2px}
    .meta .m{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;font-size:13px}
    label{display:block;margin:12px 0 4px;font-size:13px;color:#334155;font-weight:600}
    select,button{width:100%;padding:12px;border-radius:10px;border:1px solid #cbd5e1;font-size:15px}
    button{background:#0f766e;color:#fff;border:none;font-weight:700;cursor:pointer;margin-top:14px}
    button:disabled{opacity:.6;cursor:not-allowed}
    .ok{margin-top:12px;color:#065f46;font-weight:700}
    .err{margin-top:12px;color:#b91c1c;font-weight:600}
    .small{font-size:12px;color:#64748b}
    .foot{margin-top:12px;padding-top:10px;border-top:1px solid #e2e8f0}
    @media(max-width:720px){.steps{grid-template-columns:1fr 1fr}.meta{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="card">
    <div class="hero">
      <div class="brand">ICL Junk Removal</div>
      <h1>Choose Your Arrival Window</h1>
      <p>You’re confirmed. This is the final step to lock your schedule.</p>
    </div>
    <div class="body">
      ${confirmation}
      <div class="steps">
        <div class="st on">Paid</div>
        <div class="st next">Schedule</div>
        <div class="st">Removed</div>
        <div class="st">Complete</div>
      </div>
      <div class="meta">
        <div class="m"><strong>Phone</strong><br>${escHtml(parsed.phone)}</div>
        <div class="m"><strong>Address</strong><br>${escHtml(lead.address_text || "On file")}</div>
      </div>
      <p class="small">You should have received your Square receipt. Pick a day + window below.</p>
      <form id="book-form">
        <input type="hidden" name="token" value="${escHtml(req.params.token)}" />
        <label for="day_iso">Day</label>
        <select id="day_iso" name="day_iso" required>${dayOptions}</select>
        <label for="window">Arrival window</label>
        <select id="window" name="window" required>${windowOptions}</select>
        <button id="book-btn" type="submit">Confirm my appointment</button>
        <div id="book-msg"></div>
      </form>
      <div class="foot">
        <p class="small">Need help? Reply HELP to our text and we’ll assist.</p>
      </div>
    </div>
  </div>
  <script>
    const form=document.getElementById('book-form');
    const msg=document.getElementById('book-msg');
    const btn=document.getElementById('book-btn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className=''; msg.textContent='';
      btn.disabled=true;
      try{
        const payload={
          token: form.token.value,
          day_iso: form.day_iso.value,
          window: form.window.value
        };
        const r=await fetch('/api/booking/confirm',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(payload)
        });
        const j=await r.json();
        if(!j.ok){throw new Error(j.error||'Could not schedule');}
        msg.className='ok';
        msg.textContent='Booked! We also sent confirmation by SMS.';
      }catch(err){
        msg.className='err';
        msg.textContent=String(err.message||err);
      }finally{
        btn.disabled=false;
      }
    });
  </script>
</body>
</html>`);
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

app.post("/api/booking/confirm", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const dayIso = String(req.body?.day_iso || "").trim();
    const window = String(req.body?.window || "").trim();
    if (!token || !dayIso || !window) return res.status(400).json({ ok: false, error: "missing_fields" });
    if (!BOOKING_WINDOWS.includes(window)) return res.status(400).json({ ok: false, error: "invalid_window" });

    const parsed = parseBookingToken(token, { maxAgeDays: 30 });
    if (!parsed.ok) return res.status(400).json({ ok: false, error: "expired_link" });

    const dayLabel = dayLabelFromIso(dayIso);
    if (!dayLabel) return res.status(400).json({ ok: false, error: "invalid_day" });
    const timingPref = `${dayLabel}, ${window}`;

    await pool.query(
      `UPDATE leads
       SET timing_pref = $1,
           conv_state = 'WINDOW_SELECTED',
           quote_status = 'WINDOW_SELECTED',
           last_seen_at = NOW()
       WHERE from_phone = $2`,
      [timingPref, parsed.phone]
    );

    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone = $1 LIMIT 1", [parsed.phone])).rows[0];
    if (!lead) return res.status(404).json({ ok: false, error: "lead_not_found" });

    insertEvent.run({
      from_phone: parsed.phone,
      event_type: "booking_link_scheduled",
      payload_json: JSON.stringify({ timing_pref: timingPref, source: "booking_link" }),
      created_at: new Date().toISOString()
    });

    // Mirror same appointment into Google Calendar when credentials exist.
    const calendarResult = await createJobEvent({
      ...lead,
      address: lead.address_text || lead.address || "",
      quote_amount: lead.quote_total_cents ? Math.round(Number(lead.quote_total_cents) / 100) : null,
      id: lead.from_phone
    }).catch(() => null);

    if (calendarResult && calendarResult.id) {
      await pool.query(
        `UPDATE leads
         SET calendar_event_id = $1,
             calendar_event_url = $2,
             calendar_sync_status = 'SYNCED',
             calendar_synced_at = NOW(),
             last_seen_at = NOW()
         WHERE from_phone = $3`,
        [calendarResult.id, calendarResult.htmlLink || null, parsed.phone]
      );
      insertEvent.run({
        from_phone: parsed.phone,
        event_type: "calendar_event_created",
        payload_json: JSON.stringify({
          source: "booking_link",
          calendar_event_id: calendarResult.id,
          calendar_event_url: calendarResult.htmlLink || null
        }),
        created_at: new Date().toISOString()
      });
    } else if (calendarResult && calendarResult.reason === "calendar_not_configured") {
      await pool.query(
        `UPDATE leads
         SET calendar_sync_status = 'NOT_CONFIGURED',
             calendar_synced_at = NOW(),
             last_seen_at = NOW()
         WHERE from_phone = $1`,
        [parsed.phone]
      );
      insertEvent.run({
        from_phone: parsed.phone,
        event_type: "calendar_event_skipped",
        payload_json: JSON.stringify({ source: "booking_link", reason: "calendar_not_configured" }),
        created_at: new Date().toISOString()
      });
    } else {
      await pool.query(
        `UPDATE leads
         SET calendar_sync_status = 'FAILED',
             calendar_synced_at = NOW(),
             last_seen_at = NOW()
         WHERE from_phone = $1`,
        [parsed.phone]
      );
      insertEvent.run({
        from_phone: parsed.phone,
        event_type: "calendar_event_failed",
        payload_json: JSON.stringify({ source: "booking_link" }),
        created_at: new Date().toISOString()
      });
    }

    const paymentMeta = await latestPaymentMetaForPhone(parsed.phone);
    const confId = paymentMeta?.confirmation_id || null;

    try {
      const sms = await sendSms(
        parsed.phone,
        `You're booked ✅ ${timingPref}\n` +
        (confId ? `Confirmation #${confId}\n` : "") +
        `We'll text before arrival. Reply HELP anytime.`
      );
      insertEvent.run({
        from_phone: parsed.phone,
        event_type: "booking_confirmation_sms_sent",
        payload_json: JSON.stringify({
          source: "booking_link",
          timing_pref: timingPref,
          confirmation_id: confId,
          twilio: sms
        }),
        created_at: new Date().toISOString()
      });
    } catch (smsErr) {
      insertEvent.run({
        from_phone: parsed.phone,
        event_type: "booking_confirmation_sms_failed",
        payload_json: JSON.stringify({
          source: "booking_link",
          timing_pref: timingPref,
          confirmation_id: confId,
          error: String(smsErr?.message || smsErr)
        }),
        created_at: new Date().toISOString()
      });
    }

    return res.json({ ok: true, timing_pref: timingPref });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/twilio/inbound", (req, res) => {
  const payload = req.body || {};
  const fromPhone = payload.From || payload.from || "unknown";
  const ts = new Date().toISOString();

  // Always respond immediately to Twilio
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  // Log raw event
  try {
    insertEvent.run({
      from_phone: fromPhone,
      event_type: "inbound_raw",
      payload_json: JSON.stringify(payload),
      created_at: ts
    });
  } catch (e) {}

  // Hand off to conversation state machine
  handleConversation(payload).catch((e) => {
    try {
      insertEvent.run({
        from_phone: fromPhone,
        event_type: "conversation_error",
        payload_json: JSON.stringify({ error: String(e && e.message ? e.message : e) }),
        created_at: new Date().toISOString()
      });
    } catch (e2) {}
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/contact.vcf", (_req, res) => {
  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:ICL Junk Removal",
    "ORG:ICL Junk Removal",
    "TEL;TYPE=CELL:+18555785014",
    "EMAIL:admin@icljunkremoval.com",
    "URL:https://icljunkremoval.com",
    "PHOTO;VALUE=URL:https://icl-twilio-intake-production.up.railway.app/public/logo.jpg",
    "END:VCARD"
  ].join("\n");
  res.set("Content-Type", "text/vcard");
  res.set("Content-Disposition", "attachment; filename=ICL-Junk-Removal.vcf");
  res.send(vcard);
});

app.get("/admin/twilio-latest", async (req, res) => {
  try {
    const from = String(req.query.from || "");
    if (!from) return res.status(400).json({ ok: false, error: "missing from" });
    const rows = await fetchLatest({ from, limit: 5 });
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/media-proxy", async (req, res) => {
  try {
    const mediaUrl = req.query.u;
    if (!mediaUrl) return res.status(400).send("missing u");
    const sid = process.env.TWILIO_ACCOUNT_SID || "";
    const tok = process.env.TWILIO_AUTH_TOKEN || "";
    if (!sid || !tok) return res.status(500).send("twilio creds missing");
    const auth = Buffer.from(sid + ":" + tok).toString("base64");
    const r = await fetch(String(mediaUrl), { headers: { Authorization: "Basic " + auth }});
    if (!r.ok) return res.status(502).send("upstream " + r.status);
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

app.get("/admin/leads", async (_req, res) => {
  try {
    const rows = (await pool.query("SELECT from_phone, last_event, substr(coalesce(last_body,''),1,80) AS last_body_80, substr(coalesce(address_text,''),1,60) AS address_60, zip_text, num_media, media_url0, distance_miles, last_seen_at FROM leads ORDER BY last_seen_at DESC LIMIT 50")).rows;
    const esc = (s) => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
    const rowsHtml = rows.map(r => {
      const mediaHref = r.media_url0 ? ("/media-proxy?u=" + encodeURIComponent(r.media_url0)) : "";
      const mediaCell = mediaHref ? "<a target='_blank' href='" + mediaHref + "'>View</a>" : "";
      return "<tr><td><a href='/admin/lead/" + esc(String(r.from_phone).replaceAll("+","%2B")) + "'>" + esc(r.from_phone) + "</a></td><td>" + esc(r.last_event) + "</td><td>" + esc(r.last_body_80) + "</td><td>" + esc(r.address_60) + "</td><td>" + esc(r.zip_text) + "</td><td>" + esc(r.num_media) + "</td><td>" + mediaCell + "</td><td>" + esc(r.distance_miles) + "</td><td>" + esc(r.last_seen_at) + "</td></tr>";
    }).join("");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>ICL Leads</title><style>body{font-family:system-ui;padding:16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;font-size:13px}th{background:#f6f6f6}</style></head><body><h2>ICL Intake Leads</h2><table><thead><tr><th>From</th><th>Last Event</th><th>Last Message</th><th>Address</th><th>ZIP</th><th>Media#</th><th>Media</th><th>Miles</th><th>Last Seen</th></tr></thead><tbody>" + rowsHtml + "</tbody></table></body></html>");
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/lead/:from", (req, res) => {
  const fp = path.join(LEADS_DIR, safeFilenameFromPhone(req.params.from) + ".json");
  if (!fs.existsSync(fp)) return res.status(404).json({ ok: false });
  res.json(JSON.parse(fs.readFileSync(fp, "utf8")));
});

app.get("/admin/lead/:from", async (req, res) => {
  try {
    const from = req.params.from;
    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone = $1", [from])).rows[0] || null;
    const events = (await pool.query("SELECT event_type, created_at, payload_json FROM events WHERE from_phone = $1 ORDER BY id DESC LIMIT 200", [from])).rows;
    const mediaUrls = [];
    for (const e of events) {
      try {
        const pj = JSON.parse(e.payload_json || "{}");
        const u = pj.MediaUrl0 || pj.mediaUrl0 || null;
        if (u && !mediaUrls.includes(u)) mediaUrls.push(u);
      } catch {}
    }
    const esc = (s) => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
    const evHtml = events.map(e => "<tr><td>" + esc(e.created_at) + "</td><td>" + esc(e.event_type) + "</td><td><pre style='white-space:pre-wrap;margin:0'>" + esc(e.payload_json) + "</pre></td></tr>").join("");
    const mediaHtml = !mediaUrls.length ? "<p>No media.</p>" : mediaUrls.map((u,i) => "<div style='margin:10px 0'><a href='/media-proxy?u=" + encodeURIComponent(u) + "' target='_blank'>Open media " + (i+1) + "</a><br/><img src='/media-proxy?u=" + encodeURIComponent(u) + "' style='max-width:360px;border:1px solid #ddd;border-radius:10px;margin-top:6px'/></div>").join("");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>Lead " + esc(from) + "</title><style>body{font-family:system-ui;padding:16px}a{color:#0366d6}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;font-size:12px;vertical-align:top}th{background:#f6f6f6}pre{max-width:100%;overflow-x:auto}</style></head><body><div><a href='/admin/leads'>← Back</a></div><h2>Lead: " + esc(from) + "</h2><pre>" + esc(JSON.stringify(lead,null,2)) + "</pre><h3>Media</h3>" + mediaHtml + "<h3>Events</h3><table><thead><tr><th>Time</th><th>Type</th><th>Payload</th></tr></thead><tbody>" + evHtml + "</tbody></table></body></html>");
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

setInterval(() => checkDropoffs().catch(e => console.error('[dropoff]', e.message)), 30*60*1000);
setTimeout(() => checkDropoffs().catch(()=>{}), 60*1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log("icl-twilio-intake listening on :" + PORT);
});

try {
  const mountTwilioExtraRoutes = require("./twilio_extra_routes");
  mountTwilioExtraRoutes(app, db, insertEvent);
  console.log("[twilio_extra_routes] mounted");
} catch (e) {
  console.error("[twilio_extra_routes] failed to mount:", e?.message || e);
}
