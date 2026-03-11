const { checkDropoffs } = require("./dropoff_monitor");
const { handleOpsReply } = require("./job_complete");
const { handleSquareWebhook } = require("./square_webhook");
const { fetchLatest } = require("./twilio_debug");
const { backfillLatestMedia } = require("./twilio_media_backfill");
const { recomputeDerived } = require("./recompute");
const { handleWindowReply } = require("./window_reply");
const { evaluateQuoteReadyRow } = require("./quote_gate");
const { handleConversation } = require("./conversation");
const { sendSms } = require("./twilio_sms");
const { recordJobCosts } = require("./finance_pipeline");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { db, pool, upsertLead, insertEvent, getLead } = require("./db");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const BASE_LOCATION = "506 E Brett St, Inglewood, CA 90301";
const BASE_COORD = { lat: 33.9776848, lon: -118.3523303 };
const SOCRATA_APP_TOKEN = process.env.OPENLA_SOCRATA_APP_TOKEN || process.env.SOCRATA_APP_TOKEN || "";
const SOCRATA_USERNAME = process.env.OPENLA_SOCRATA_USERNAME || "";
const SOCRATA_PASSWORD = process.env.OPENLA_SOCRATA_PASSWORD || "";
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

async function socrataFetchJson(url) {
  const headers = {};
  if (SOCRATA_APP_TOKEN) headers["X-App-Token"] = SOCRATA_APP_TOKEN;
  if (SOCRATA_USERNAME && SOCRATA_PASSWORD) {
    headers.Authorization = "Basic " + Buffer.from(`${SOCRATA_USERNAME}:${SOCRATA_PASSWORD}`).toString("base64");
  }
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`socrata_http_${r.status}`);
  const j = await r.json();
  if (j && j.error) throw new Error(`socrata_error_${j.message || "unknown"}`);
  return j;
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

const MATRIX_CACHE = new Map();
const MATRIX_TTL_MS = 90 * 1000;
const OPP_CACHE = { ts: 0, data: null };
const OPP_TTL_MS = 10 * 60 * 1000;
const TERRITORY_BBOX = { minLng: -118.41, minLat: 33.95, maxLng: -118.32, maxLat: 34.03 };
const DEFAULT_CAPILLARY_STREETS = [
  { name: "Stocker St", coords: [[-118.364, 34.001], [-118.354, 33.999], [-118.345, 33.997], [-118.336, 33.995], [-118.329, 33.993]] },
  { name: "Windsor Arterial", coords: [[-118.360, 33.986], [-118.353, 33.982], [-118.346, 33.978], [-118.340, 33.974], [-118.335, 33.970]] },
  { name: "Park-Windsor East/West", coords: [[-118.356, 33.972], [-118.349, 33.972], [-118.342, 33.972], [-118.336, 33.972], [-118.329, 33.972]] },
  { name: "Baldwin Village Connector", coords: [[-118.353, 34.012], [-118.346, 34.008], [-118.339, 34.003], [-118.333, 33.999]] },
  { name: "Crenshaw Inner Spine", coords: [[-118.346, 34.006], [-118.344, 33.999], [-118.342, 33.992], [-118.340, 33.985], [-118.338, 33.978]] },
  { name: "Slauson Ave", coords: [[-118.371, 33.989], [-118.350, 33.989], [-118.329, 33.989]] }
];
const CAPILLARY_CONFIG_DIR = path.join(__dirname, "config");
const CAPILLARY_GEOJSON_FILE = process.env.CAPILLARY_GEOJSON_PATH || path.join(CAPILLARY_CONFIG_DIR, "capillary.geojson");
const CAPILLARY_KML_FILE = process.env.CAPILLARY_KML_PATH || path.join(CAPILLARY_CONFIG_DIR, "capillary.kml");
const CAPILLARY_CACHE = { ts: 0, streets: DEFAULT_CAPILLARY_STREETS, source: "v1_screenshot_inference", loaded_at: null };
const CAPILLARY_CACHE_TTL_MS = 45 * 1000;

function matrixCacheKey(points) {
  return points.map((p) => `${Number(p.lat).toFixed(4)},${Number(p.lng).toFixed(4)}`).join("|");
}

function toOsrmCoord(p) {
  return `${Number(p.lng).toFixed(6)},${Number(p.lat).toFixed(6)}`;
}

function normalizeLineCoords(coords) {
  if (!Array.isArray(coords)) return [];
  return coords
    .map((pt) => {
      const lng = Number(Array.isArray(pt) ? pt[0] : pt?.lng);
      const lat = Number(Array.isArray(pt) ? pt[1] : pt?.lat);
      return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
    })
    .filter(Boolean);
}

function parseGeoJsonCapillary(raw) {
  const j = typeof raw === "string" ? JSON.parse(raw) : raw;
  const features = Array.isArray(j?.features)
    ? j.features
    : j?.type === "Feature"
      ? [j]
      : j?.type
        ? [{ type: "Feature", properties: {}, geometry: j }]
        : [];
  const streets = [];
  for (const f of features) {
    const geom = f?.geometry || {};
    const name = String(f?.properties?.name || f?.properties?.Name || f?.properties?.title || "Imported corridor");
    if (geom.type === "LineString") {
      const coords = normalizeLineCoords(geom.coordinates);
      if (coords.length >= 2) streets.push({ name, coords });
    } else if (geom.type === "MultiLineString" && Array.isArray(geom.coordinates)) {
      geom.coordinates.forEach((line, idx) => {
        const coords = normalizeLineCoords(line);
        if (coords.length >= 2) streets.push({ name: `${name} ${idx + 1}`, coords });
      });
    }
  }
  return streets;
}

function parseKmlCapillary(rawText) {
  const text = String(rawText || "");
  const streets = [];
  const coordRegex = /<coordinates>([\s\S]*?)<\/coordinates>/gi;
  let m;
  let idx = 1;
  while ((m = coordRegex.exec(text)) !== null) {
    const line = m[1]
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((triplet) => {
        const parts = triplet.split(",");
        return [Number(parts[0]), Number(parts[1])];
      })
      .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
    if (line.length >= 2) {
      streets.push({ name: `Imported corridor ${idx}`, coords: line });
      idx += 1;
    }
  }
  return streets;
}

function capillarySegments(streets) {
  const out = [];
  for (const s of Array.isArray(streets) ? streets : []) {
    const coords = normalizeLineCoords(s?.coords);
    for (let i = 0; i < coords.length - 1; i += 1) {
      out.push([coords[i], coords[i + 1]]);
    }
  }
  return out;
}

function loadCapillaryNetwork(force = false) {
  if (!force && CAPILLARY_CACHE.loaded_at && (Date.now() - CAPILLARY_CACHE.ts) < CAPILLARY_CACHE_TTL_MS) {
    return CAPILLARY_CACHE;
  }
  let streets = DEFAULT_CAPILLARY_STREETS;
  let source = "v1_screenshot_inference";
  try {
    if (fs.existsSync(CAPILLARY_GEOJSON_FILE)) {
      const raw = fs.readFileSync(CAPILLARY_GEOJSON_FILE, "utf8");
      const parsed = parseGeoJsonCapillary(raw);
      if (parsed.length) {
        streets = parsed;
        source = `geojson:${path.basename(CAPILLARY_GEOJSON_FILE)}`;
      }
    } else if (fs.existsSync(CAPILLARY_KML_FILE)) {
      const raw = fs.readFileSync(CAPILLARY_KML_FILE, "utf8");
      const parsed = parseKmlCapillary(raw);
      if (parsed.length) {
        streets = parsed;
        source = `kml:${path.basename(CAPILLARY_KML_FILE)}`;
      }
    }
  } catch (e) {
    console.error("[capillary] load error:", e?.message || e);
  }
  CAPILLARY_CACHE.ts = Date.now();
  CAPILLARY_CACHE.loaded_at = new Date().toISOString();
  CAPILLARY_CACHE.streets = streets;
  CAPILLARY_CACHE.source = source;
  return CAPILLARY_CACHE;
}

function capillaryGeoJson(streets) {
  return {
    type: "FeatureCollection",
    features: (Array.isArray(streets) ? streets : []).map((s) => ({
      type: "Feature",
      properties: { name: s?.name || "Capillary corridor" },
      geometry: { type: "LineString", coordinates: normalizeLineCoords(s?.coords) }
    }))
  };
}

function xmlEsc(v) {
  return String(v || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function capillaryKml(streets) {
  const placemarks = (Array.isArray(streets) ? streets : [])
    .map((s) => {
      const coords = normalizeLineCoords(s?.coords).map((pt) => `${pt[0]},${pt[1]},0`).join(" ");
      if (!coords) return "";
      return `<Placemark><name>${xmlEsc(s?.name || "Capillary corridor")}</name><LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString></Placemark>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>ICL Capillary Corridors</name>
    ${placemarks}
  </Document>
</kml>`;
}

async function fetchOsrmDurationMatrix(points) {
  const coords = points.map(toOsrmCoord).join(";");
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`osrm_http_${r.status}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.durations)) throw new Error("osrm_bad_payload");
  const matrix = j.durations.map((row) =>
    row.map((sec) => (Number.isFinite(sec) ? Math.max(1, Math.round(sec / 60)) : null))
  );
  return { matrix, mode: "osrm_road" };
}

async function fetchGoogleTrafficMatrix(points) {
  const key = process.env.GOOGLE_MAPS_API_KEY || "";
  if (!key) return null;
  const origins = points.map((p) => `${p.lat},${p.lng}`).join("|");
  const destinations = origins;
  const url = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  url.searchParams.set("origins", origins);
  url.searchParams.set("destinations", destinations);
  url.searchParams.set("departure_time", "now");
  url.searchParams.set("traffic_model", "best_guess");
  url.searchParams.set("key", key);
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`gdm_http_${r.status}`);
  const j = await r.json();
  if (!j || j.status !== "OK" || !Array.isArray(j.rows)) throw new Error(`gdm_status_${j?.status || "bad"}`);
  const matrix = j.rows.map((row) =>
    (row.elements || []).map((el) => {
      if (!el || el.status !== "OK") return null;
      const sec = Number((el.duration_in_traffic && el.duration_in_traffic.value) || (el.duration && el.duration.value) || 0);
      return sec > 0 ? Math.max(1, Math.round(sec / 60)) : null;
    })
  );
  return { matrix, mode: "google_traffic" };
}

async function getDurationMatrix(points) {
  const key = matrixCacheKey(points);
  const cached = MATRIX_CACHE.get(key);
  if (cached && (Date.now() - cached.ts) < MATRIX_TTL_MS) return cached.value;
  let value = null;
  try {
    value = await fetchGoogleTrafficMatrix(points);
  } catch {}
  if (!value) value = await fetchOsrmDurationMatrix(points);
  MATRIX_CACHE.set(key, { ts: Date.now(), value });
  return value;
}

function routeTravelCost(routeIdxs, matrix) {
  if (!routeIdxs.length) return 0;
  let cost = Number(matrix?.[0]?.[routeIdxs[0] + 1] || 9999);
  for (let i = 0; i < routeIdxs.length - 1; i += 1) {
    cost += Number(matrix?.[routeIdxs[i] + 1]?.[routeIdxs[i + 1] + 1] || 9999);
  }
  return cost;
}

function pointToSegmentMiles(lat, lng, a, b) {
  const latRad = (lat * Math.PI) / 180;
  const sx = (a[0] - lng) * 69 * Math.cos(latRad);
  const sy = (a[1] - lat) * 69;
  const ex = (b[0] - lng) * 69 * Math.cos(latRad);
  const ey = (b[1] - lat) * 69;
  const dx = ex - sx;
  const dy = ey - sy;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-12) return Math.hypot(sx, sy);
  const t = Math.max(0, Math.min(1, -((sx * dx) + (sy * dy)) / len2));
  const px = sx + t * dx;
  const py = sy + t * dy;
  return Math.hypot(px, py);
}

function minCapillaryDistanceMiles(lat, lng, segments) {
  let best = Number.POSITIVE_INFINITY;
  for (const seg of (Array.isArray(segments) ? segments : [])) {
    const d = pointToSegmentMiles(lat, lng, seg[0], seg[1]);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : 99;
}

function capillaryBonus(distanceMi) {
  if (distanceMi <= 0.2) return 12;
  if (distanceMi <= 0.4) return 7;
  if (distanceMi <= 0.7) return 3;
  return 0;
}

function twoOptRoute(routeIdxs, matrix) {
  if (routeIdxs.length < 4) return routeIdxs;
  let best = [...routeIdxs];
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 2; i += 1) {
      for (let k = i + 1; k < best.length - 1; k += 1) {
        const next = [...best];
        const rev = next.slice(i, k + 1).reverse();
        next.splice(i, rev.length, ...rev);
        if (routeTravelCost(next, matrix) < routeTravelCost(best, matrix)) {
          best = next;
          improved = true;
        }
      }
    }
  }
  return best;
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

function computePriority(stage, risk, inactivityMin, etaMin, plannerBonus = 0) {
  const s = stage === "red" ? 55 : stage === "yellow" ? 35 : 5;
  const r = risk === "high" ? 35 : risk === "medium" ? 15 : 0;
  const inactivity = Math.min(40, Math.floor(inactivityMin / 5));
  return Math.round(s + r + inactivity - Math.min(18, etaMin * 0.35) + Number(plannerBonus || 0));
}

const OPS_ALERT_PHONE = process.env.OPS_ALERT_PHONE || "+12138806318";

function inAutomationWindow(d = new Date()) {
  const hour = getPacificHour(d);
  return hour >= 8 && hour <= 19;
}

function nextActionLabel(row, stage, inactivityMin) {
  const conv = String(row.conv_state || row.quote_status || "").toUpperCase();
  if (stage === "green") return "review_referral";
  if (conv.includes("AWAITING_MEDIA")) return "send_media";
  if (conv.includes("AWAITING_ADDRESS")) return "send_address_zip";
  if (conv.includes("QUOTE") || conv.includes("DEPOSIT")) return "close_deposit";
  if (inactivityMin >= 120) return "call_now";
  return "step_nudge";
}

function nextActionSms(kind) {
  if (kind === "send_media") return "Quick nudge: send a few photos so we can finalize your quote + timing.";
  if (kind === "send_address_zip") return "Quick nudge: send your service address + ZIP to lock quote accuracy.";
  if (kind === "close_deposit") return "Quick nudge: your quote is ready to lock. Reply YES and we will secure your arrival window.";
  if (kind === "call_now") return "Quick check-in: we can close this in one call. Reply CALL and we will ring you now.";
  return "Quick check-in: reply here and we will move your job to the next step immediately.";
}

async function fireNextBestActionAutomation() {
  if (!inAutomationWindow()) return;
  const rows = (
    await pool.query(
      `SELECT
         l.from_phone,
         l.last_seen_at,
         l.first_seen_at,
         l.conv_state,
         l.quote_status,
         l.deposit_paid,
         l.address_text,
         l.next_action_sent_at,
         l.next_action_sent_count,
         EXISTS(
           SELECT 1 FROM events e
           WHERE e.from_phone = l.from_phone
             AND e.event_type = 'job_completed'
         ) AS has_completed_event
       FROM leads l
       WHERE COALESCE(l.troll_flag, 0) = 0
        AND l.archived_at IS NULL
       ORDER BY l.last_seen_at DESC
       LIMIT 280`
    )
  ).rows;
  const now = Date.now();
  for (const row of rows) {
    const life = leadLifecycle(row);
    if (life.stage === "green") continue;
    const lastSeen = new Date(row.last_seen_at || row.first_seen_at || now).getTime();
    const inactivityMin = Math.max(0, Math.floor((now - lastSeen) / 60000));
    if (inactivityMin < 60) continue;
    const sentCount = Number(row.next_action_sent_count || 0);
    if (sentCount >= 4) continue;
    const lastSentMs = row.next_action_sent_at ? new Date(row.next_action_sent_at).getTime() : 0;
    const cooldownMin = life.stage === "red" ? 90 : 180;
    if (lastSentMs && ((now - lastSentMs) / 60000) < cooldownMin) continue;
    const kind = nextActionLabel(row, life.stage, inactivityMin);
    const body = nextActionSms(kind);
    try {
      await sendSms(row.from_phone, body);
      await pool.query(
        `UPDATE leads
         SET next_action_sent_at = NOW(),
             next_action_sent_count = COALESCE(next_action_sent_count, 0) + 1,
             next_action_last_kind = $1,
             next_action_last_error = NULL
         WHERE from_phone = $2`,
        [kind, row.from_phone]
      );
      insertEvent.run({
        from_phone: row.from_phone,
        event_type: "next_best_action_auto",
        payload_json: JSON.stringify({ kind, inactivity_minutes: inactivityMin, stage: life.stage }),
        created_at: new Date().toISOString()
      });
      try {
        await sendSms(
          OPS_ALERT_PHONE,
          `SLA RED auto-fired · ${row.from_phone}\n${kind}\n${row.address_text || "No address"}\nIdle ${inactivityMin}m`
        );
      } catch {}
    } catch (e) {
      await pool.query(
        "UPDATE leads SET next_action_last_error = $1 WHERE from_phone = $2",
        [String(e?.message || e), row.from_phone]
      ).catch(() => {});
    }
  }
}

function buildRouteSuggestionV2(candidates, matrix, maxStops = 8, mode = "osrm_road") {
  if (!candidates.length) return [];
  const pool = candidates.map((p) => ({ ...p }));
  let currentIdx = pool.reduce((best, p, i, arr) =>
    (arr[best].priority_score >= p.priority_score ? best : i), 0);
  const order = [currentIdx];
  const used = new Set(order);
  while (order.length < Math.min(maxStops, pool.length)) {
    let nextIdx = -1;
    let nextCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < pool.length; i += 1) {
      if (used.has(i)) continue;
      const travel = Number(matrix?.[order[order.length - 1] + 1]?.[i + 1] || 9999);
      const riskBoost = pool[i].risk === "high" ? -6 : pool[i].risk === "medium" ? -2 : 0;
      const score = travel - (pool[i].priority_score || 0) * 0.18 + riskBoost;
      if (score < nextCost) {
        nextCost = score;
        nextIdx = i;
      }
    }
    if (nextIdx < 0) break;
    order.push(nextIdx);
    used.add(nextIdx);
  }
  const optimized = twoOptRoute(order, matrix);
  const route = [];
  let cur = { lat: BASE_COORD.lat, lng: BASE_COORD.lon };
  optimized.forEach((idx, n) => {
    const p = pool[idx];
    const legMiles = haversineMiles(cur.lat, cur.lng, p.lat, p.lng);
    route.push({
      stop: n + 1,
      phone: p.phone,
      stage: p.stage,
      stage_label: p.stage_label,
      risk: p.risk,
      eta_minutes_est: p.eta_minutes_est,
      leg_miles: Number(legMiles.toFixed(2)),
      address: p.address,
      conv_state: p.conv_state,
      traffic_model: mode
    });
    cur = { lat: p.lat, lng: p.lng };
  });
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

function territoryEnvelopeParams() {
  return {
    geometry: `${TERRITORY_BBOX.minLng},${TERRITORY_BBOX.minLat},${TERRITORY_BBOX.maxLng},${TERRITORY_BBOX.maxLat}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects"
  };
}

async function arcgisQuery(layerId, opts = {}) {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: opts.outFields || "*",
    returnGeometry: "true",
    f: "pjson",
    resultRecordCount: String(opts.resultRecordCount || 80),
    ...territoryEnvelopeParams()
  });
  const base = "https://maps.lacity.org/arcgis/rest/services/Permits/BOE_Permits_Geocoder/MapServer";
  const url = `${base}/${layerId}/query?${params.toString()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`arcgis_${layerId}_${r.status}`);
  const j = await r.json();
  if (j?.error) throw new Error(`arcgis_${layerId}_error`);
  return Array.isArray(j.features) ? j.features : [];
}

function parseArcPoint(f) {
  const x = Number(f?.geometry?.x);
  const y = Number(f?.geometry?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { lat: y, lng: x };
}

function parseArcPaths(f) {
  const p = f?.geometry?.paths;
  if (!Array.isArray(p) || !p.length || !Array.isArray(p[0])) return null;
  return p[0]
    .map((xy) => ({ lng: Number(xy[0]), lat: Number(xy[1]) }))
    .filter((pt) => Number.isFinite(pt.lat) && Number.isFinite(pt.lng));
}

async function fetchBudgetSignals() {
  try {
    const y = new Date().getFullYear();
    const fyA = String(y - 1);
    const fyB = String(y);
    const where = `fiscal_year in ('${fyA}','${fyB}') AND council_district in ('8','9','10','11')`;
    const base = "https://controllerdata.lacity.org/resource/ebs9-fdwv.json";
    const q1 = new URL(base);
    q1.searchParams.set("$select", "council_district,sum(amount) as amount_total,count(*) as txn_count");
    q1.searchParams.set("$where", where);
    q1.searchParams.set("$group", "council_district");
    q1.searchParams.set("$order", "amount_total DESC");
    q1.searchParams.set("$limit", "20");
    const byCd = await socrataFetchJson(q1.toString());

    const q2 = new URL(base);
    q2.searchParams.set("$select", "sum(amount) as amount_total,count(*) as txn_count");
    q2.searchParams.set("$where", `${where} AND (upper(transaction_details) like '%STREET%' OR upper(transaction_details) like '%TRANSIT%' OR upper(transaction_details) like '%HOUSING%' OR upper(transaction_details) like '%DEVELOP%' OR upper(transaction_details) like '%HOMELESS%' OR upper(transaction_details) like '%INFRA%')`);
    q2.searchParams.set("$limit", "1");
    const thematic = await socrataFetchJson(q2.toString());

    const rows = Array.isArray(byCd) ? byCd : [];
    const topical = (Array.isArray(thematic) && thematic[0]) ? thematic[0] : { amount_total: 0, txn_count: 0 };
    return {
      by_cd: rows.map((r) => ({
        council_district: String(r.council_district || ""),
        amount_total: Number(r.amount_total || 0),
        txn_count: Number(r.txn_count || 0)
      })),
      topical: {
        amount_total: Number(topical.amount_total || 0),
        txn_count: Number(topical.txn_count || 0)
      }
    };
  } catch {
    return { by_cd: [], topical: { amount_total: 0, txn_count: 0 } };
  }
}

async function fetchCityBudgetOpportunitySignals() {
  try {
    const q = new URL("https://data.lacity.org/resource/5242-pnmt.json");
    q.searchParams.set("$select", "fiscal_year,sum(appropriation) as total_budget");
    q.searchParams.set("$where", "upper(department_name) like '%TRANSPORT%' OR upper(department_name) like '%PUBLIC WORKS%' OR upper(department_name) like '%HOUSING%'");
    q.searchParams.set("$group", "fiscal_year");
    q.searchParams.set("$order", "fiscal_year DESC");
    q.searchParams.set("$limit", "3");
    const rows = await socrataFetchJson(q.toString());
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      fiscal_year: String(r.fiscal_year || ""),
      total_budget: Number(r.total_budget || 0)
    }));
  } catch {
    return [];
  }
}

async function buildOpportunityData() {
  const cacheFresh = OPP_CACHE.data && (Date.now() - OPP_CACHE.ts) < OPP_TTL_MS;
  if (cacheFresh) return OPP_CACHE.data;
  const [permitFeatures, housingFeatures, corridorFeatures, transitFeatures, budgetSignals, cityBudgetSignals] = await Promise.all([
    arcgisQuery(11, { resultRecordCount: 120, outFields: "PermitNo,PermitType,PermitSubType,Location,StartDate,EndDate,TOOLTIP,NLA_URL" }).catch(() => []),
    arcgisQuery(153, { resultRecordCount: 100, outFields: "PROJECT_NA,AV_ADD,TOOLTIP,NLA_URL" }).catch(() => []),
    arcgisQuery(200, { resultRecordCount: 40, outFields: "Street,Street_From,Street_To,CD,Region,TOOLTIP,NLA_URL" }).catch(() => []),
    arcgisQuery(208, { resultRecordCount: 40, outFields: "ProjectTitle,CurrentPhaseDescription,CouncilDistrict,ConstructionCost,TOOLTIP,NLA_URL" }).catch(() => []),
    fetchBudgetSignals(),
    fetchCityBudgetOpportunitySignals()
  ]);

  const permits = permitFeatures
    .map((f) => {
      const pt = parseArcPoint(f);
      if (!pt) return null;
      const a = f.attributes || {};
      return {
        type: "permit",
        title: String(a.PermitNo || "B Permit Construction").trim(),
        subtitle: String(a.Location || ""),
        tooltip: String(a.TOOLTIP || ""),
        url: a.NLA_URL || null,
        lat: pt.lat,
        lng: pt.lng,
        start_date: a.StartDate || null,
        end_date: a.EndDate || null,
        opportunity_score: 1
      };
    })
    .filter(Boolean);

  const housing = housingFeatures
    .map((f) => {
      const pt = parseArcPoint(f);
      if (!pt) return null;
      const a = f.attributes || {};
      return {
        type: "housing",
        title: String(a.PROJECT_NA || "Affordable Housing Project"),
        subtitle: String(a.AV_ADD || ""),
        tooltip: String(a.TOOLTIP || ""),
        url: a.NLA_URL || null,
        lat: pt.lat,
        lng: pt.lng,
        opportunity_score: 3
      };
    })
    .filter(Boolean);

  const corridors = corridorFeatures
    .map((f) => {
      const path = parseArcPaths(f);
      if (!path || !path.length) return null;
      const a = f.attributes || {};
      return {
        type: "corridor",
        title: String(a.Street || "Great Streets Corridor"),
        subtitle: `${a.Street_From || ""} → ${a.Street_To || ""}`.trim(),
        tooltip: String(a.TOOLTIP || ""),
        url: a.NLA_URL || null,
        path,
        opportunity_score: 4
      };
    })
    .filter(Boolean);

  const transit = transitFeatures
    .map((f) => {
      const path = parseArcPaths(f);
      if (!path || !path.length) return null;
      const a = f.attributes || {};
      return {
        type: "transit",
        title: String(a.ProjectTitle || "Transit Project"),
        subtitle: String(a.CurrentPhaseDescription || ""),
        tooltip: String(a.TOOLTIP || ""),
        url: a.NLA_URL || null,
        path,
        construction_cost: Number(a.ConstructionCost || 0),
        opportunity_score: 5
      };
    })
    .filter(Boolean);

  const data = {
    permits,
    housing,
    corridors,
    transit,
    budget_signals: budgetSignals,
    city_budget_signals: cityBudgetSignals,
    meta: {
      permit_count: permits.length,
      housing_count: housing.length,
      corridor_count: corridors.length,
      transit_count: transit.length,
      city_budget_count: cityBudgetSignals.length,
      generated_at: new Date().toISOString()
    }
  };
  OPP_CACHE.ts = Date.now();
  OPP_CACHE.data = data;
  return data;
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

app.get("/api/dashboard/capillary", (_req, res) => {
  const cap = loadCapillaryNetwork();
  res.json({
    ok: true,
    source: cap.source,
    loaded_at: cap.loaded_at,
    streets: cap.streets
  });
});

app.get("/api/dashboard/capillary.geojson", (_req, res) => {
  const cap = loadCapillaryNetwork();
  res.setHeader("Content-Type", "application/geo+json; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=icl-capillary-corridors.geojson");
  res.end(JSON.stringify(capillaryGeoJson(cap.streets), null, 2));
});

app.get("/api/dashboard/capillary.kml", (_req, res) => {
  const cap = loadCapillaryNetwork();
  res.setHeader("Content-Type", "application/vnd.google-earth.kml+xml; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=icl-capillary-corridors.kml");
  res.end(capillaryKml(cap.streets));
});

app.post("/admin/capillary/import", (req, res) => {
  try {
    const format = String(req.body?.format || "geojson").toLowerCase();
    const payload = req.body?.data ?? req.body?.geojson ?? req.body?.kml ?? null;
    if (payload == null) return res.status(400).json({ ok: false, error: "missing data" });
    fs.mkdirSync(CAPILLARY_CONFIG_DIR, { recursive: true });
    if (format === "kml") {
      const text = String(payload);
      const parsed = parseKmlCapillary(text);
      if (!parsed.length) return res.status(400).json({ ok: false, error: "no valid KML linework found" });
      fs.writeFileSync(CAPILLARY_KML_FILE, text, "utf8");
    } else {
      const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
      const parsed = parseGeoJsonCapillary(obj);
      if (!parsed.length) return res.status(400).json({ ok: false, error: "no valid GeoJSON linework found" });
      fs.writeFileSync(CAPILLARY_GEOJSON_FILE, JSON.stringify(obj, null, 2), "utf8");
    }
    const cap = loadCapillaryNetwork(true);
    return res.json({
      ok: true,
      source: cap.source,
      loaded_at: cap.loaded_at,
      street_count: cap.streets.length,
      segment_count: capillarySegments(cap.streets).length
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/admin/job-costs", async (req, res) => {
  try {
    const fromPhone = String(req.body?.from_phone || req.body?.phone || "").trim();
    if (!fromPhone) return res.status(400).json({ ok: false, error: "missing from_phone" });
    const margin = await recordJobCosts(
      fromPhone,
      {
        labor: req.body?.labor,
        disposal: req.body?.disposal,
        fuel: req.body?.fuel,
        other: req.body?.other,
        labor_cents: req.body?.labor_cents,
        disposal_cents: req.body?.disposal_cents,
        fuel_cents: req.body?.fuel_cents,
        other_cents: req.body?.other_cents
      },
      "admin_api"
    );
    res.json({ ok: true, from_phone: fromPhone, margin });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

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
        l.junk_fee_actual,
        l.settled_revenue_cents,
        l.total_cost_cents,
        l.margin_cents,
        l.margin_pct,
        l.next_action_sent_count,
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
      WHERE l.archived_at IS NULL
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
      settled_revenue_cents: Number(r.settled_revenue_cents || 0) || null,
      total_cost_cents: Number(r.total_cost_cents || 0) || null,
      margin_cents: Number(r.margin_cents || 0) || null,
      margin_pct: Number(r.margin_pct || 0) || null,
      next_action_sent_count: Number(r.next_action_sent_count || 0)
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
      const priorityScore = computePriority(life.stage, risk, inactivityMin, etaMin, 0);
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
    let etaMode = "heuristic_peak_profile";
    const routeCandidates = pins
      .filter((p) => p.stage !== "green")
      .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
      .slice(0, 12)
      .map((p) => ({ ...p }));
    let routeSuggestion = [];
    if (routeCandidates.length) {
      const matrixPoints = [{ lat: BASE_COORD.lat, lng: BASE_COORD.lon }, ...routeCandidates.map((p) => ({ lat: p.lat, lng: p.lng }))];
      try {
        const dm = await getDurationMatrix(matrixPoints);
        etaMode = dm.mode;
        routeCandidates.forEach((c, idx) => {
          const eta = Number(dm.matrix?.[0]?.[idx + 1]);
          if (Number.isFinite(eta) && eta > 0) c.eta_minutes_est = eta;
        });
        const etaByPhone = new Map(routeCandidates.map((c) => [c.phone, c.eta_minutes_est]));
        pins.forEach((p) => {
          if (etaByPhone.has(p.phone)) p.eta_minutes_est = etaByPhone.get(p.phone);
        });
        routeSuggestion = buildRouteSuggestionV2(routeCandidates, dm.matrix, 8, dm.mode);
      } catch {
        routeSuggestion = buildRouteSuggestionV2(routeCandidates, null, 8, etaMode);
      }
    }
    const stageCounts = pins.reduce((a, p) => { a[p.stage] = (a[p.stage] || 0) + 1; return a; }, { red: 0, yellow: 0, green: 0 });
    const riskCounts = pins.reduce((a, p) => { a[p.risk] = (a[p.risk] || 0) + 1; return a; }, { high: 0, medium: 0, low: 0 });
    const rowByPhone = new Map(rows.map((r) => [String(r.from_phone), r]));
    const todayKey = new Date().toDateString();
    const bookedToday = pins.filter((p) => p.stage === "green").filter((p) => {
      const rs = rowByPhone.get(String(p.phone));
      return new Date(rs?.last_seen_at || 0).toDateString() === todayKey;
    }).length;
    const depositRate = pins.length ? Math.round(((stageCounts.yellow + stageCounts.green) / pins.length) * 100) : 0;
    const settledRows = rows.filter((r) => Number(r.settled_revenue_cents || 0) > 0);
    const revenueSamples = settledRows
      .map((r) => Number(r.settled_revenue_cents))
      .filter((v) => Number.isFinite(v) && v > 0);
    const marginSamples = settledRows
      .map((r) => Number(r.margin_cents))
      .filter((v) => Number.isFinite(v));
    const avgRevenueJob = revenueSamples.length
      ? Math.round(revenueSamples.reduce((s, v) => s + v, 0) / revenueSamples.length)
      : null;
    const avgMarginJob = marginSamples.length
      ? Math.round(marginSamples.reduce((s, v) => s + v, 0) / marginSamples.length)
      : null;
    const squareConnected = Boolean(process.env.SQUARE_ACCESS_TOKEN || process.env.SQUARE_API_TOKEN || process.env.SQUARE_TOKEN);
    const active = pins.filter((p) => p.stage !== "green");
    const slaRedCount = active.filter((p) => Number(p.inactivity_minutes || 0) >= 60).length;
    const automationCount = rows.reduce((sum, r) => sum + Number(r.next_action_sent_count || 0), 0);
    const avgEta = active.length ? Math.round(active.reduce((s, p) => s + (p.eta_minutes_est || 0), 0) / active.length) : 0;
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
        booked_today: bookedToday,
        deposit_rate: depositRate,
        avg_revenue_job: avgRevenueJob,
        avg_margin_job: avgMarginJob,
        margin_truth_jobs: settledRows.length,
        square_connected: squareConnected,
        sla_red_count: slaRedCount,
        next_actions_sent_total: automationCount,
        eta_mode: etaMode,
        generated_at: new Date().toISOString()
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/dashboard/opportunities", async (_req, res) => {
  try {
    const data = await buildOpportunityData();
    res.json({ ok: true, ...data });
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

app.get("/admin/leads", async (req, res) => {
  try {
    const mode = String(req.query.show || "active").toLowerCase();
    const where =
      mode === "archived"
        ? "WHERE l.archived_at IS NOT NULL"
        : mode === "all"
          ? ""
          : "WHERE l.archived_at IS NULL";
    const rows = (await pool.query(
      `SELECT
        l.from_phone,
        l.last_event,
        substr(coalesce(l.last_body,''),1,80) AS last_body_80,
        substr(coalesce(l.address_text,''),1,60) AS address_60,
        l.zip_text,
        l.num_media,
        l.has_media,
        l.media_url0,
        l.distance_miles,
        l.last_seen_at,
        l.archived_at
      FROM leads l
      ${where}
      ORDER BY l.last_seen_at DESC
      LIMIT 200`
    )).rows;
    const esc = (s) => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
    const rowsHtml = rows.map(r => {
      const mediaHref = r.media_url0 ? ("/media-proxy?u=" + encodeURIComponent(r.media_url0)) : "";
      const previewCell = mediaHref
        ? "<a target='_blank' href='" + mediaHref + "' title='Open media'>" +
            "<img src='" + mediaHref + "' alt='media preview' loading='lazy' style='width:88px;height:66px;object-fit:cover;border:1px solid #d9d9d9;border-radius:8px;background:#f7f7f7'/>" +
          "</a>"
        : "<span style='color:#888'>—</span>";
      const mediaCell = mediaHref ? "<a target='_blank' href='" + mediaHref + "'>Open</a>" : "";
      const mediaCount = Number(r.num_media || 0);
      const mediaSent = mediaCount > 0 || Number(r.has_media || 0) === 1 || !!r.media_url0;
      const mediaSentCell = mediaSent
        ? "<span style='display:inline-block;padding:2px 8px;border-radius:999px;background:#e7f7ef;border:1px solid #8fd3ac;color:#166534;font-size:11px'>Yes (" + mediaCount + ")</span>"
        : "<span style='display:inline-block;padding:2px 8px;border-radius:999px;background:#f4f4f5;border:1px solid #d4d4d8;color:#52525b;font-size:11px'>No</span>";
      const encodedPhone = encodeURIComponent(String(r.from_phone));
      const returnTo = "/admin/leads?show=" + (mode === "archived" ? "archived" : mode === "all" ? "all" : "active");
      const actionCell = r.archived_at
        ? "<form method='POST' action='/admin/lead/" + encodedPhone + "/unarchive' style='margin:0'><input type='hidden' name='return_to' value='" + esc(returnTo) + "'/><button type='submit' style='font-size:11px;padding:5px 8px;border:1px solid #0ea5e9;border-radius:6px;background:#f0f9ff;color:#0369a1;cursor:pointer'>Unarchive</button></form>"
        : "<form method='POST' action='/admin/lead/" + encodedPhone + "/archive' style='margin:0' onsubmit='return confirm(\"Archive this lead?\")'><input type='hidden' name='return_to' value='" + esc(returnTo) + "'/><button type='submit' style='font-size:11px;padding:5px 8px;border:1px solid #f59e0b;border-radius:6px;background:#fffbeb;color:#92400e;cursor:pointer'>Archive</button></form>";
      return "<tr><td><a href='/admin/lead/" + encodedPhone + "'>" + esc(r.from_phone) + "</a></td><td>" + esc(r.last_event) + "</td><td>" + esc(r.last_body_80) + "</td><td>" + esc(r.address_60) + "</td><td>" + esc(r.zip_text) + "</td><td>" + mediaSentCell + "</td><td>" + esc(r.num_media) + "</td><td>" + previewCell + "</td><td>" + mediaCell + "</td><td>" + esc(r.distance_miles) + "</td><td>" + esc(r.last_seen_at) + "</td><td>" + actionCell + "</td></tr>";
    }).join("");
    const modeActive = mode === "active" || (mode !== "archived" && mode !== "all");
    const modeArchived = mode === "archived";
    const modeAll = mode === "all";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      "<html><head><title>ICL Leads</title><style>body{font-family:system-ui;padding:16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;font-size:13px;vertical-align:top}th{background:#f6f6f6}.tabs{display:flex;gap:8px;margin:8px 0 14px}.tab{padding:6px 10px;border:1px solid #ddd;border-radius:8px;background:#fff;color:#333;text-decoration:none;font-size:12px}.tab.on{background:#111827;color:#fff;border-color:#111827}</style></head><body>" +
      "<h2>ICL Intake Leads</h2>" +
      "<div class='tabs'>" +
      "<a class='tab " + (modeActive ? "on" : "") + "' href='/admin/leads?show=active'>Active</a>" +
      "<a class='tab " + (modeArchived ? "on" : "") + "' href='/admin/leads?show=archived'>Archived</a>" +
      "<a class='tab " + (modeAll ? "on" : "") + "' href='/admin/leads?show=all'>All</a>" +
      "</div>" +
      "<table><thead><tr><th>From</th><th>Last Event</th><th>Last Message</th><th>Address</th><th>ZIP</th><th>Media Sent</th><th>Media#</th><th>Media Preview</th><th>Media</th><th>Miles</th><th>Last Seen</th><th>Action</th></tr></thead><tbody>" +
      rowsHtml +
      "</tbody></table></body></html>"
    );
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function adminReturnPath(req, fallback = "/admin/leads") {
  const candidate = String(req.body?.return_to || req.query?.return_to || fallback);
  return candidate.startsWith("/admin/") ? candidate : fallback;
}

app.post("/admin/lead/:from/archive", async (req, res) => {
  try {
    const from = String(req.params.from || "");
    await pool.query("UPDATE leads SET archived_at = NOW(), archived_reason = COALESCE($1, archived_reason), last_seen_at = NOW() WHERE from_phone = $2", [String(req.body?.reason || "manual_archive"), from]);
    return res.redirect(adminReturnPath(req, "/admin/leads?show=active"));
  } catch (e) {
    return res.status(500).send(String(e));
  }
});

app.post("/admin/lead/:from/unarchive", async (req, res) => {
  try {
    const from = String(req.params.from || "");
    await pool.query("UPDATE leads SET archived_at = NULL, archived_reason = NULL, last_seen_at = NOW() WHERE from_phone = $1", [from]);
    return res.redirect(adminReturnPath(req, "/admin/leads?show=archived"));
  } catch (e) {
    return res.status(500).send(String(e));
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
    const mediaSet = new Set();
    for (const e of events) {
      try {
        const pj = JSON.parse(e.payload_json || "{}");
        // Capture all Twilio payload media keys (MediaUrl0..MediaUrl9) plus legacy fields.
        for (const [k, v] of Object.entries(pj)) {
          if (/^MediaUrl\d+$/.test(k) && v) mediaSet.add(String(v));
        }
        if (Array.isArray(pj.allMediaUrls)) {
          for (const u of pj.allMediaUrls) if (u) mediaSet.add(String(u));
        }
        const u = pj.MediaUrl0 || pj.mediaUrl0 || null;
        if (u) mediaSet.add(String(u));
      } catch {}
    }
    for (const u of mediaSet) mediaUrls.push(u);
    const esc = (s) => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
    const evHtml = events.map(e => "<tr><td>" + esc(e.created_at) + "</td><td>" + esc(e.event_type) + "</td><td><pre style='white-space:pre-wrap;margin:0'>" + esc(e.payload_json) + "</pre></td></tr>").join("");
    const mediaHtml = !mediaUrls.length ? "<p>No media.</p>" : mediaUrls.map((u,i) => "<div style='margin:10px 0'><a href='/media-proxy?u=" + encodeURIComponent(u) + "' target='_blank'>Open media " + (i+1) + "</a><br/><img src='/media-proxy?u=" + encodeURIComponent(u) + "' loading='lazy' style='max-width:360px;border:1px solid #ddd;border-radius:10px;margin-top:6px'/></div>").join("");
    const encodedPhone = encodeURIComponent(String(from));
    const archiveControl = lead?.archived_at
      ? "<form method='POST' action='/admin/lead/" + encodedPhone + "/unarchive' style='display:inline;margin-left:10px'><input type='hidden' name='return_to' value='/admin/lead/" + encodedPhone + "'/><button type='submit' style='padding:6px 10px;border-radius:8px;border:1px solid #0ea5e9;background:#f0f9ff;color:#0369a1;cursor:pointer'>Unarchive</button></form>"
      : "<form method='POST' action='/admin/lead/" + encodedPhone + "/archive' style='display:inline;margin-left:10px' onsubmit='return confirm(\"Archive this lead?\")'><input type='hidden' name='return_to' value='/admin/lead/" + encodedPhone + "'/><button type='submit' style='padding:6px 10px;border-radius:8px;border:1px solid #f59e0b;background:#fffbeb;color:#92400e;cursor:pointer'>Archive</button></form>";
    const archivedBadge = lead?.archived_at
      ? "<span style='display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#fef3c7;border:1px solid #f59e0b;color:#92400e;font-size:11px'>Archived</span>"
      : "";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>Lead " + esc(from) + "</title><style>body{font-family:system-ui;padding:16px}a{color:#0366d6}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;font-size:12px;vertical-align:top}th{background:#f6f6f6}pre{max-width:100%;overflow-x:auto}</style></head><body><div><a href='/admin/leads'>← Back</a></div><h2>Lead: " + esc(from) + archivedBadge + archiveControl + "</h2><pre>" + esc(JSON.stringify(lead,null,2)) + "</pre><h3>Media</h3>" + mediaHtml + "<h3>Events</h3><table><thead><tr><th>Time</th><th>Type</th><th>Payload</th></tr></thead><tbody>" + evHtml + "</tbody></table></body></html>");
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

setInterval(() => checkDropoffs().catch(e => console.error('[dropoff]', e.message)), 30*60*1000);
setTimeout(() => checkDropoffs().catch(()=>{}), 60*1000);
setInterval(() => fireNextBestActionAutomation().catch(e => console.error("[next_action_auto]", e?.message || e)), 10 * 60 * 1000);
setTimeout(() => fireNextBestActionAutomation().catch(() => {}), 90 * 1000);

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
