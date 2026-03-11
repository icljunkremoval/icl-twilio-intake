const { checkDropoffs } = require("./dropoff_monitor");
const { handleOpsReply } = require("./job_complete");
const { handleSquareWebhook } = require("./square_webhook");
const { fetchLatest } = require("./twilio_debug");
const { backfillLatestMedia } = require("./twilio_media_backfill");
const { recomputeDerived } = require("./recompute");
const { handleWindowReply } = require("./window_reply");
const { evaluateQuoteReadyRow } = require("./quote_gate");
const { handleConversation } = require("./conversation");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { db, pool, upsertLead, insertEvent, getLead } = require("./db");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const BASE_LOCATION = "506 E Brett St, Inglewood, CA 90301";
const BASE_COORD = { lat: 33.9776848, lon: -118.3523303 };
const ZIP_CENTROIDS = {
  "90008": { lat: 34.0075, lng: -118.3498 },
  "90016": { lat: 34.0151, lng: -118.3554 },
  "90043": { lat: 33.9854, lng: -118.3396 },
  "90056": { lat: 33.9738, lng: -118.3718 },
};

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

async function geocodeOSM(q, timeoutMs = 2800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", q);
  try {
    const r = await fetch(url.toString(), {
      headers: { "User-Agent": "ICL-Twilio-Intake/1.0" },
      signal: controller.signal
    });
    const j = await r.json();
    if (!Array.isArray(j) || j.length === 0) return null;
    return { lat: Number(j[0].lat), lon: Number(j[0].lon), display: j[0].display_name };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function leadLifecycle(row) {
  const quote = String(row.quote_status || "").toUpperCase();
  const conv = String(row.conv_state || "").toUpperCase();
  const completed = quote.includes("COMPLETED") || quote.includes("REVIEW") || !!row.has_completed_event;
  if (completed) return { stage: "green", label: "Completed / review" };
  const depositLike =
    Number(row.deposit_paid) === 1 ||
    quote === "DEPOSIT_PAID" ||
    quote === "BOOKING_SENT" ||
    quote === "WINDOW_SELECTED" ||
    conv === "BOOKING_SENT" ||
    conv === "AWAITING_DAY" ||
    conv === "WINDOW_SELECTED";
  if (depositLike) return { stage: "yellow", label: "Deposit paid / scheduled" };
  return { stage: "red", label: "Lead (pre-deposit)" };
}

function getPacificHour(d = new Date()) {
  const p = new Date(d.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return p.getHours();
}

function trafficMultiplier(now = new Date()) {
  const h = getPacificHour(now);
  if ((h >= 7 && h <= 10) || (h >= 15 && h <= 19)) return 1.35;
  if (h >= 11 && h <= 14) return 1.2;
  return 1.05;
}

function estimateEtaMinutes(distanceMiles, now = new Date()) {
  const mph = 23;
  const m = trafficMultiplier(now);
  const mins = (distanceMiles / mph) * 60 * m;
  return Math.max(6, Math.round(mins));
}

function computeRisk(stage, convState, inactivityMin) {
  const u = String(convState || "").toUpperCase();
  if (u === "ESCALATED") return "high";
  if (stage === "red" && inactivityMin >= 30) return "high";
  if (stage === "yellow" && inactivityMin >= 180) return "high";
  if (stage === "red" && inactivityMin >= 12) return "medium";
  if (stage === "yellow" && inactivityMin >= 60) return "medium";
  return "low";
}

function computePriority(stage, risk, inactivityMin, etaMin) {
  const s = stage === "red" ? 55 : stage === "yellow" ? 35 : 5;
  const r = risk === "high" ? 35 : risk === "medium" ? 15 : 0;
  const inactivity = Math.min(40, Math.floor(inactivityMin / 5));
  return Math.round(s + r + inactivity - Math.min(18, etaMin * 0.35));
}

function buildRouteSuggestion(pins, maxStops = 8) {
  const candidates = pins
    .filter((p) => p.stage !== "green")
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
    .slice(0, 20)
    .map((p) => ({ ...p }));
  const route = [];
  let cur = { lat: BASE_COORD.lat, lng: BASE_COORD.lon };
  while (candidates.length && route.length < maxStops) {
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < candidates.length; i += 1) {
      const p = candidates[i];
      const d = haversineMiles(cur.lat, cur.lng, p.lat, p.lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = candidates.splice(bestIdx, 1)[0];
    route.push({
      stop: route.length + 1,
      phone: next.phone,
      stage: next.stage,
      stage_label: next.stage_label,
      risk: next.risk,
      eta_minutes_est: next.eta_minutes_est,
      leg_miles: Number(bestDist.toFixed(2)),
      address: next.address,
      conv_state: next.conv_state
    });
    cur = { lat: next.lat, lng: next.lng };
  }
  return route;
}

function hasValidLeadGeo(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat > 33.85 && lat < 34.15 &&
    lng > -118.55 && lng < -118.15
  );
}

async function resolveLeadCoordinates(row) {
  const lat = Number(row.geo_lat);
  const lng = Number(row.geo_lng);
  if (hasValidLeadGeo(lat, lng)) {
    return { lat, lng, source: row.geo_source || "cached" };
  }

  const zip = String(row.zip || row.zip_text || "").match(/\b\d{5}\b/)?.[0] || "";
  const address = String(row.address_text || "").trim();
  let geo = null;
  let source = "osm";

  if (address) {
    const parts = [address];
    if (zip && !address.includes(zip)) parts.push(zip);
    parts.push("Los Angeles, CA");
    geo = await geocodeOSM(parts.join(", "));
  }
  if (!geo && zip && ZIP_CENTROIDS[zip]) {
    geo = { lat: ZIP_CENTROIDS[zip].lat, lon: ZIP_CENTROIDS[zip].lng };
    source = "zip_fallback";
  }
  if (!geo) return null;

  await pool.query(
    "UPDATE leads SET geo_lat=$1, geo_lng=$2, geocoded_at=NOW(), geo_source=$3 WHERE from_phone=$4",
    [Number(geo.lat), Number(geo.lon), source, row.from_phone]
  ).catch(() => {});
  return { lat: Number(geo.lat), lng: Number(geo.lon), source };
}

const app = express();
app.use("/public", require("express").static(require("path").join(__dirname, "public")));
app.use(express.json({ limit: "2mb" }))
// Territory dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
;
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

app.get("/api/dashboard/leads", async (req, res) => {
  try {
    const rawLimit = Number(req.query.limit || 120);
    const limit = Number.isFinite(rawLimit) ? Math.max(20, Math.min(250, Math.floor(rawLimit))) : 120;
    const rows = (await pool.query(
      `SELECT
        l.from_phone,
        l.first_seen_at,
        l.last_seen_at,
        l.address_text,
        l.zip,
        l.zip_text,
        l.conv_state,
        l.quote_status,
        l.deposit_paid,
        l.deposit_paid_at,
        l.load_bucket,
        l.geo_lat,
        l.geo_lng,
        l.geocoded_at,
        l.geo_source,
        EXISTS(
          SELECT 1 FROM events e
          WHERE e.from_phone = l.from_phone
            AND e.event_type = 'job_completed'
        ) AS has_completed_event
      FROM leads l
      ORDER BY l.last_seen_at DESC
      LIMIT $1`,
      [limit]
    )).rows;

    const leads = rows.map((r) => ({
      phone: r.from_phone,
      from_phone: r.from_phone,
      state: r.conv_state || r.quote_status || "NEW",
      created_at: r.first_seen_at || r.last_seen_at,
      last_seen_at: r.last_seen_at,
      address: r.address_text || "",
      zip: r.zip || r.zip_text || "",
      load_bucket: r.load_bucket || null,
      quote_status: r.quote_status || null,
      deposit_paid: Number(r.deposit_paid) === 1,
    }));

    let geocodeAttempts = 0;
    const now = new Date();
    const pins = [];
    for (const row of rows) {
      if (!row.address_text) continue;
      let lat = Number(row.geo_lat);
      let lng = Number(row.geo_lng);
      let source = row.geo_source || "cached";
      if (!hasValidLeadGeo(lat, lng) && geocodeAttempts < 12) {
        geocodeAttempts += 1;
        const geo = await resolveLeadCoordinates(row);
        if (geo) {
          lat = geo.lat;
          lng = geo.lng;
          source = geo.source;
        }
      }
      if (!hasValidLeadGeo(lat, lng)) {
        const zip = String(row.zip || row.zip_text || "").match(/\b\d{5}\b/)?.[0] || "";
        if (ZIP_CENTROIDS[zip]) {
          lat = ZIP_CENTROIDS[zip].lat;
          lng = ZIP_CENTROIDS[zip].lng;
          source = "zip_fallback";
        }
      }
      if (!hasValidLeadGeo(lat, lng)) continue;
      const life = leadLifecycle(row);
      const miles = haversineMiles(BASE_COORD.lat, BASE_COORD.lon, lat, lng);
      const etaMin = estimateEtaMinutes(miles, now);
      const inactivityMin = Math.max(0, Math.floor((Date.now() - new Date(row.last_seen_at || row.first_seen_at || Date.now()).getTime()) / 60000));
      const risk = computeRisk(life.stage, row.conv_state, inactivityMin);
      const priorityScore = computePriority(life.stage, risk, inactivityMin, etaMin);
      pins.push({
        phone: row.from_phone,
        address: row.address_text,
        zip: row.zip || row.zip_text || "",
        lat,
        lng,
        stage: life.stage,
        stage_label: life.label,
        conv_state: row.conv_state || null,
        quote_status: row.quote_status || null,
        source,
        eta_minutes_est: etaMin,
        distance_miles_to_base: Number(miles.toFixed(2)),
        inactivity_minutes: inactivityMin,
        risk,
        priority_score: priorityScore
      });
    }
    const stageCounts = pins.reduce((a, p) => { a[p.stage] = (a[p.stage] || 0) + 1; return a; }, { red: 0, yellow: 0, green: 0 });
    const riskCounts = pins.reduce((a, p) => { a[p.risk] = (a[p.risk] || 0) + 1; return a; }, { high: 0, medium: 0, low: 0 });
    const active = pins.filter((p) => p.stage !== "green");
    const avgEta = active.length ? Math.round(active.reduce((s, p) => s + (p.eta_minutes_est || 0), 0) / active.length) : 0;
    const routeSuggestion = buildRouteSuggestion(pins, 8);
    res.json({
      ok: true,
      leads,
      pins,
      route_suggestion: routeSuggestion,
      meta: {
        total: leads.length,
        pins: pins.length,
        stage_counts: stageCounts,
        risk_counts: riskCounts,
        avg_eta_min: avgEta,
        generated_at: new Date().toISOString()
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
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
