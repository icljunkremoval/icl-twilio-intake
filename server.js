const { checkDropoffs } = require("./dropoff_monitor");
const { handleOpsReply } = require("./job_complete");
const { handleSquareWebhook, simulateDepositForPhone } = require("./square_webhook");
const { fetchLatest } = require("./twilio_debug");
const { backfillLatestMedia } = require("./twilio_media_backfill");
const { recomputeDerived } = require("./recompute");
const { handleWindowReply } = require("./window_reply");
const { evaluateQuoteReadyRow } = require("./quote_gate");
const { handleConversation } = require("./conversation");
const { listWorldviewLeads } = require("./worldview_intel");
const { extractVisionBuckets } = require("./vision_buckets");
const { analyzeBase64Images } = require("./vision_analyzer");
const { parseBookingToken } = require("./booking_link");
const { createJobEvent, getBookedWindows } = require("./calendar");
const { createSquarePaymentOptions } = require("./square_quote");
const { priceQuoteV1 } = require("./pricing_v1");
const { sendSms } = require("./twilio_sms");
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");
const { execSync } = require("child_process");
const { db, pool, upsertLead, insertEvent, getLead } = require("./db");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const BASE_LOCATION = "506 E Brett St, Inglewood, CA 90301";
const BASE_COORD = { lat: 33.9776848, lng: -118.3523303 };
const OPS_ALERT_PHONE = String(process.env.OPS_ALERT_PHONE || "+12138806318").trim();
const CALL_FOLLOWUP_SMS =
  "Thanks for calling ICL Junk Removal. Send up to 10 photos of what you need removed (the more information we have, the more accurate the quote).";
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
const MANUAL_MEDIA_INLINE_MAX_BYTES = 5 * 1024 * 1024;
const MANUAL_MEDIA_MAX_FILES = 10;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: MANUAL_MEDIA_MAX_FILES }
});
const DASHBOARD_DUMPSITES_FALLBACK = [
  // Priority transfer stations
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
    address: "9530 S Garfield Ave, South Gate, CA 90280",
    phone: "(562) 927-0146",
    notes: "ICL default site. Closest to territory.",
    availability: { state: "open", label: "Open" }
  },
  {
    id: "compton_republic",
    name: "Republic Compton Transfer Station",
    kind: "transfer",
    tier: "primary",
    status: "open",
    lat: 33.9033397,
    lng: -118.2443543,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Mon-Fri 6:00 AM-5:30 PM · Sat/Sun closed",
    address: "2509 W Rosecrans Ave, Compton, CA 90059",
    phone: "(310) 327-8461",
    notes: "Close to core territory. Weekdays only.",
    availability: { state: "open", label: "Open" }
  },
  {
    id: "waste_resources_gardena",
    name: "Waste Resources Recovery",
    kind: "transfer",
    tier: "primary",
    status: "call",
    lat: 33.8961185,
    lng: -118.1966994,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm",
    address: "357 W Compton Blvd, Gardena, CA 90247",
    phone: "(310) 366-7600",
    notes: "Very close; confirm current commercial hours.",
    availability: { state: "call", label: "Call ahead" }
  },

  // Nearby transfer options
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
    address: "1449 W Rosecrans Ave, Gardena, CA 90249",
    phone: "(310) 527-6980",
    notes: "Limited schedule; Monday + Saturday focus.",
    availability: { state: "open", label: "Open (limited days)" }
  },
  {
    id: "culver_city_transfer",
    name: "Culver City Transfer & Recycling",
    kind: "transfer",
    tier: "nearby",
    status: "call",
    lat: 33.9836,
    lng: -118.3907,
    msw: true,
    accepts: "MSW, recyclables, e-waste (Sat)",
    hours_text: "Call to confirm",
    address: "9255 W Jefferson Blvd, Culver City, CA 90232",
    phone: "(310) 253-5635",
    notes: "City-operated; verify commercial access.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "dart_downey",
    name: "Downey Area Recycling & Transfer (DART)",
    kind: "transfer",
    tier: "nearby",
    status: "open",
    lat: 33.924255,
    lng: -118.113248,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Mon-Fri 6:00 AM-5:30 PM · Sat 6:00 AM-1:30 PM",
    address: "9770 Washburn Rd, Downey, CA 90241",
    phone: "(562) 622-3503",
    notes: "Athens-operated; good southeast backup.",
    availability: { state: "open", label: "Open" }
  },
  {
    id: "carson_wm",
    name: "WM Carson Transfer Station & MRF",
    kind: "transfer",
    tier: "nearby",
    status: "call",
    lat: 33.8503778,
    lng: -118.282476,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm",
    address: "321 W Francisco St, Carson, CA 90745",
    phone: "(310) 217-6300",
    notes: "WM facility; verify hauler rates/hours.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "edco_signal_hill",
    name: "EDCO Recycling & Transfer",
    kind: "transfer",
    tier: "nearby",
    status: "call",
    lat: 33.8072959,
    lng: -118.180745,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm",
    address: "2755 California Ave, Signal Hill, CA 90755",
    phone: "(562) 997-1122",
    notes: "South Bay backup option.",
    availability: { state: "call", label: "Call ahead" }
  },

  // Regional transfer options
  {
    id: "puente_hills_mrf",
    name: "Puente Hills MRF (LACSD)",
    kind: "transfer",
    tier: "regional",
    status: "open",
    lat: 34.0310902,
    lng: -118.0114286,
    msw: true,
    accepts: "MSW, food/green waste, recyclables",
    hours_text: "Mon-Sat 4:00 AM-5:00 PM · Sun closed",
    address: "13130 Crossroads Pkwy S, City of Industry, CA 91746",
    phone: "(562) 908-4288 ext. 6074",
    notes: "Early open for pre-dawn runs.",
    availability: { state: "open", label: "Open" }
  },
  {
    id: "athens_industry_mrf",
    name: "Athens Services MRF",
    kind: "transfer",
    tier: "regional",
    status: "call",
    lat: 34.0264,
    lng: -117.9957,
    msw: true,
    accepts: "MSW, recyclables, organics",
    hours_text: "Call to confirm commercial hours",
    address: "14048 E Valley Blvd, Industry, CA 91746",
    phone: "(626) 336-3636",
    notes: "Large regional operator; confirm self-haul rates.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "east_la_transfer",
    name: "East LA Recycling & Transfer",
    kind: "transfer",
    tier: "regional",
    status: "call",
    lat: 34.058134,
    lng: -118.182351,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm",
    address: "1512 N Bonnie Beach Pl, Los Angeles, CA 90063",
    phone: "(562) 663-3400",
    notes: "East LA option.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "bel_art_long_beach",
    name: "Bel-Art Waste Transfer (Republic)",
    kind: "transfer",
    tier: "regional",
    status: "call",
    lat: 33.8783829,
    lng: -118.1625177,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm",
    address: "2501 E 68th St, Long Beach, CA 90805",
    phone: "(562) 663-3429",
    notes: "South / Long Beach network option.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "grand_central_industry",
    name: "Grand Central Recycling & Transfer",
    kind: "transfer",
    tier: "regional",
    status: "call",
    lat: 34.0033839,
    lng: -117.9232729,
    msw: true,
    accepts: "MSW, recyclables, C&D",
    hours_text: "Call to confirm",
    address: "999 Hatcher Ave, Industry, CA 91748",
    phone: "(626) 855-5556",
    notes: "Large private facility.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "universal_waste_springs",
    name: "Universal Waste Services",
    kind: "transfer",
    tier: "regional",
    status: "call",
    lat: 33.9594883,
    lng: -118.0709726,
    msw: false,
    accepts: "Universal waste, recyclables",
    hours_text: "Call to confirm",
    address: "9010 Norwalk Blvd, Santa Fe Springs, CA 90670",
    phone: "(562) 695-8236",
    notes: "Specialty streams; not standard MSW-first choice.",
    availability: { state: "call", label: "Call ahead" }
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
    address: "4489 Ardine St, South Gate, CA 90280",
    phone: "(323) 560-8488",
    notes: "Secondary South Gate option (different operator).",
    availability: { state: "open", label: "Open" }
  },
  {
    id: "allan_baldwin_park",
    name: "Allan Company MRF — Baldwin Park",
    kind: "transfer",
    tier: "regional",
    status: "call",
    lat: 34.1068363,
    lng: -117.9577343,
    msw: true,
    accepts: "Recyclables, MSW",
    hours_text: "Call to confirm",
    address: "14604 Arrow Hwy, Baldwin Park, CA 91706",
    phone: "(626) 962-4047",
    notes: "East Valley option.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "glendale_mrf_ts",
    name: "City of Glendale MRF & TS",
    kind: "transfer",
    tier: "regional",
    status: "call",
    lat: 34.1333513,
    lng: -118.2635969,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm",
    address: "540 W Chevy Chase Dr, Glendale, CA 91204",
    phone: "(626) 962-4047",
    notes: "May have jurisdiction restrictions.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "paramount_resource",
    name: "Paramount Resource Recycling Facility",
    kind: "transfer",
    tier: "regional",
    status: "call",
    lat: 33.9071609,
    lng: -118.1723969,
    msw: true,
    accepts: "Recyclables, MSW",
    hours_text: "Call to confirm",
    address: "7230 Petterson Ln, Paramount, CA 90723",
    phone: "(562) 602-6505",
    notes: "Southeast LA option.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "pico_rivera_mrf",
    name: "Pico Rivera MRF (WM Recycle America)",
    kind: "transfer",
    tier: "regional",
    status: "call",
    lat: 34.0007514,
    lng: -118.094514,
    msw: true,
    accepts: "Recyclables, MSW",
    hours_text: "Call to confirm",
    address: "8405 Loch Lomond Dr, Pico Rivera, CA 90660",
    phone: "(562) 948-3888",
    notes: "WM regional MRF option.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "city_terrace_transfer",
    name: "City Terrace Recycling Transfer Station",
    kind: "transfer",
    tier: "regional",
    status: "call",
    lat: 34.0574543,
    lng: -118.1908901,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm",
    address: "1511 Fishburn Ave, Los Angeles, CA 90063",
    phone: "(323) 780-7150",
    notes: "East LA area.",
    availability: { state: "call", label: "Call ahead" }
  },

  // Far transfer options
  {
    id: "azusa_transfer_mrf",
    name: "Azusa Transfer & MRF",
    kind: "transfer",
    tier: "far",
    status: "call",
    lat: 34.1139,
    lng: -117.932,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm",
    address: "1501 W Gladstone Ave, Azusa, CA 91701",
    phone: "(818) 252-3148",
    notes: "San Gabriel Valley; use when routing east.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "allan_santa_monica",
    name: "Allan Company — Santa Monica",
    kind: "transfer",
    tier: "far",
    status: "call",
    lat: 34.0255092,
    lng: -118.4678251,
    msw: true,
    accepts: "Recyclables, MSW",
    hours_text: "Call to confirm",
    address: "2411 Delaware Ave, Santa Monica, CA 90404",
    phone: "(310) 453-4677",
    notes: "Westside option; confirm commercial access.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "southern_cal_disposal_sm",
    name: "Southern Cal. Disposal R&TS",
    kind: "transfer",
    tier: "far",
    status: "call",
    lat: 34.0258646,
    lng: -118.4667749,
    msw: true,
    accepts: "MSW, recyclables",
    hours_text: "Call to confirm",
    address: "1908 Frank St, Santa Monica, CA 90404",
    phone: "(310) 828-6444",
    notes: "Westside transfer option.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "pomona_valley_transfer",
    name: "Pomona Valley Transfer Station",
    kind: "transfer",
    tier: "far",
    status: "call",
    lat: 34.0520823,
    lng: -117.7287079,
    msw: true,
    accepts: "MSW, recyclables, C&D",
    hours_text: "Call to confirm",
    address: "1371 E 9th St, Pomona, CA 91766",
    phone: "(626) 855-5538",
    notes: "Far east option.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "mission_west_coast_pomona",
    name: "Mission Recycling / West Coast Recycling",
    kind: "transfer",
    tier: "far",
    status: "call",
    lat: 34.0518943,
    lng: -117.7296403,
    msw: true,
    accepts: "Recyclables, MSW",
    hours_text: "Call to confirm",
    address: "1326 E 9th St, Pomona, CA 91766",
    phone: "(909) 620-4688",
    notes: "Adjacent Pomona facilities.",
    availability: { state: "call", label: "Call ahead" }
  },

  // Landfills
  {
    id: "sunshine_canyon",
    name: "Sunshine Canyon Landfill",
    kind: "landfill",
    tier: "regional",
    status: "open",
    lat: 34.3032234,
    lng: -118.4644237,
    msw: true,
    accepts: "MSW, C&D, green waste, tires, clean dirt",
    hours_text: "Mon-Fri 6:00 AM-6:00 PM · Sat 7:00 AM-12:00 PM",
    address: "14747 San Fernando Rd, Sylmar, CA 91342",
    phone: "(818) 362-2124",
    notes: "Largest active LA landfill; open to LA County haulers.",
    availability: { state: "open", label: "Open" }
  },
  {
    id: "calabasas_landfill",
    name: "Calabasas Landfill",
    kind: "landfill",
    tier: "regional",
    status: "open",
    lat: 34.1455,
    lng: -118.7052,
    msw: true,
    accepts: "MSW, inert, green waste, asphalt, manifested tires",
    hours_text: "Mon-Fri 8:00 AM-5:00 PM · Sat 8:00 AM-2:30 PM",
    address: "5300 Lost Hills Rd, Agoura Hills, CA 91301",
    phone: "(818) 889-0363",
    notes: "Wasteshed restrictions apply (west of 405 focus).",
    availability: { state: "open", label: "Open" }
  },
  {
    id: "scholl_canyon_landfill",
    name: "Scholl Canyon Landfill",
    kind: "landfill",
    tier: "restricted",
    status: "restricted",
    lat: 34.1491881,
    lng: -118.1901798,
    msw: true,
    accepts: "MSW",
    hours_text: "Mon-Fri 8:00 AM-5:00 PM · Sat 8:00 AM-3:30 PM",
    address: "3001 Scholl Canyon Rd, Glendale, CA 91206",
    phone: "(818) 243-9779",
    notes: "Restricted wasteshed; generally not for ICL standard territory.",
    availability: { state: "restricted", label: "Restricted" }
  },
  {
    id: "savage_canyon_whittier",
    name: "Savage Canyon Landfill",
    kind: "landfill",
    tier: "regional",
    status: "call",
    lat: 33.987,
    lng: -118.031,
    msw: true,
    accepts: "MSW",
    hours_text: "Call to confirm",
    address: "13919 E Penn St, Whittier, CA 90602",
    phone: "(562) 464-3510",
    notes: "Whittier-operated; verify commercial access.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "lancaster_landfill",
    name: "Lancaster Landfill & Recycling Center",
    kind: "landfill",
    tier: "far",
    status: "call",
    lat: 34.69,
    lng: -118.119,
    msw: true,
    accepts: "MSW",
    hours_text: "Call to confirm",
    address: "600 E Ave F, Lancaster, CA 93535",
    phone: "(661) 223-3437",
    notes: "Antelope Valley only (too far for routine runs).",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "antelope_valley_landfill",
    name: "Antelope Valley Public Landfill",
    kind: "landfill",
    tier: "far",
    status: "call",
    lat: 34.5678473,
    lng: -118.1426433,
    msw: true,
    accepts: "MSW",
    hours_text: "Call to confirm",
    address: "1200 W City Ranch Rd, Palmdale, CA 93551",
    phone: "(661) 223-3418",
    notes: "Antelope Valley routing only.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "azusa_landfill",
    name: "Azusa Land Reclamation Landfill",
    kind: "landfill",
    tier: "far",
    status: "call",
    lat: 34.113,
    lng: -117.93,
    msw: true,
    accepts: "MSW",
    hours_text: "Call to confirm",
    address: "2401 Delaware Ave, Azusa, CA 91702",
    phone: "(626) 969-1384",
    notes: "East Valley landfill option.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "burbank_landfill_3",
    name: "Burbank Landfill Site No. 3",
    kind: "landfill",
    tier: "far",
    status: "call",
    lat: 34.2056016,
    lng: -118.3082675,
    msw: true,
    accepts: "MSW",
    hours_text: "Call to confirm",
    address: "1600 Lockheed View Dr, Burbank, CA 91504",
    phone: "(818) 238-3888",
    notes: "May restrict to city/jurisdiction haulers.",
    availability: { state: "call", label: "Call ahead" }
  },
  {
    id: "montebello_land_water",
    name: "Montebello Land & Water Co.",
    kind: "landfill",
    tier: "regional",
    status: "restricted",
    lat: 34.0146814,
    lng: -118.1118019,
    msw: false,
    accepts: "Inert/fill materials",
    hours_text: "Call to confirm",
    address: "344 E Madison Ave, Montebello, CA 90640",
    phone: "(323) 722-8654",
    notes: "Specialized inert facility; not general junk MSW.",
    availability: { state: "restricted", label: "Restricted" }
  },
  {
    id: "chiquita_canyon",
    name: "Chiquita Canyon Landfill",
    kind: "landfill",
    tier: "closed",
    status: "closed",
    lat: 34.432,
    lng: -118.646,
    msw: true,
    accepts: "N/A",
    hours_text: "Permanently closed (Jan 1, 2025)",
    address: "29201 Henry Mayo Dr, Castaic, CA 91384",
    phone: "—",
    notes: "Do not route. Permanently closed.",
    availability: { state: "closed", label: "Closed" }
  }
];
const CHRISTMAS_LIGHTS_CSV_CANDIDATES = [
  path.join(__dirname, "data", "christmas_lights_customers.csv"),
  "/home/ubuntu/.cursor/projects/workspace/uploads/2025_ICL_Squarespace_Leads_-_Jobs_Done__2_.csv"
];
const CHRISTMAS_LIGHTS_GEO_CACHE = new Map();
const CHRISTMAS_LIGHTS_DATA_CACHE = {
  path: null,
  mtimeMs: 0,
  rows: []
};

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
  const stateU = String(leadState(lead)).toUpperCase();
  const quoteU = String(lead?.quote_status || "").toUpperCase();
  if (stateU.includes("COMPLETED") || quoteU.includes("COMPLETED")) return "completed";
  if (Number(lead?.deposit_paid) === 1) return "paid";
  const flow = flowBucketFromState(leadState(lead));
  if (flow === "quoted" || flow === "deposit" || flow === "booked") return "deposit";
  return "lead";
}

function stageLabel(stage) {
  if (stage === "completed") return "Job Completed";
  if (stage === "paid") return "Paid";
  if (stage === "deposit") return "Deposit";
  return "Lead";
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

function safeJsonParse(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch { return null; }
}

function mergeUniqueStrings(base, extra, limit = 8) {
  const out = [];
  const seen = new Set();
  const src = [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])];
  for (const raw of src) {
    const item = String(raw || "").trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizePhoneE164(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length > 11) return "+" + digits;
  return null;
}

function parseQuotedAmountToCents(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function normalizeLeadSource(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "sms";
  if (["manual", "in_person", "inperson", "consult"].includes(s)) return "manual";
  if (s === "sms") return "sms";
  return s.slice(0, 24);
}

function csvTruthy(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return v === "yes" || v === "y" || v === "true" || v === "1";
}

function parseCsvText(text) {
  const out = [];
  const src = String(text || "");
  let row = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      if (inQuotes && src[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      row.push(cur);
      cur = "";
      if (row.some((cell) => String(cell || "").trim() !== "")) out.push(row);
      row = [];
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  if (row.some((cell) => String(cell || "").trim() !== "")) out.push(row);
  return out;
}

function normalizeCsvHeader(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s;
}

function christmasRankScore(rankRaw) {
  const rank = String(rankRaw || "").trim().toUpperCase();
  if (!rank) return 0;
  if (rank.startsWith("A1")) return 120;
  if (rank.startsWith("A")) return 110;
  if (rank.startsWith("B")) return 90;
  if (rank.startsWith("C")) return 70;
  if (rank.startsWith("D")) return 50;
  if (rank.startsWith("F")) return 20;
  return 40;
}

function christmasCustomerSortScore(customer) {
  const rankPoints = christmasRankScore(customer.rank);
  const bankPoints = Math.max(0, Math.min(200, Math.round((Number(customer.in_bank_cents || 0) || 0) / 1000)));
  const jobsPoints = Math.max(0, Math.min(30, Number(customer.jobs || 0) || 0));
  const cardPoints = customer.christmas_card ? 10 : 0;
  return rankPoints + bankPoints + jobsPoints + cardPoints;
}

function resolveChristmasLightsCsvPath() {
  for (const p of CHRISTMAS_LIGHTS_CSV_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function parseChristmasLightsCsv(rawText) {
  const rows = parseCsvText(rawText);
  if (!rows.length) return [];
  const headerIdx = rows.findIndex((r) => {
    const joined = r.map((v) => String(v || "").toLowerCase()).join(" | ");
    return joined.includes("first name") && joined.includes("address");
  });
  if (headerIdx < 0) return [];
  const headers = (rows[headerIdx] || []).map((h, i) => normalizeCsvHeader(h) || `col_${i}`);
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const rawRow = rows[i] || [];
    const rowObj = {};
    for (let c = 0; c < headers.length; c++) {
      rowObj[headers[c]] = String(rawRow[c] || "").trim();
    }
    const firstName = String(rowObj.first_name || "").trim();
    const lastName = String(rowObj.last_name || "").trim();
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const address = String(rowObj.address || "").trim();
    let city = String(rowObj.city || "").trim();
    let zip = String(rowObj.zip || "").replace(/[^\d]/g, "").slice(0, 5);
    if (!zip) {
      const mCity = city.match(/\b(\d{5})(?:-\d{4})?\b/);
      if (mCity) zip = mCity[1];
    }
    if (!zip) {
      const mAddr = address.match(/\b(\d{5})(?:-\d{4})?\b/);
      if (mAddr) zip = mAddr[1];
    }
    city = city
      .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
      .replace(/,\s*$/, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!address && !(city && zip)) continue;
    const phoneRaw = String(rowObj.number || "").trim();
    const inBankCents = parseQuotedAmountToCents(rowObj.in_the_bank);
    const jobs = Number(String(rowObj.jobs || "").replace(/[^\d.-]/g, ""));
    const customer = {
      id: `xmas_${i + 1}`,
      source_row: i + 1,
      name: name || null,
      first_name: firstName || null,
      last_name: lastName || null,
      phone_raw: phoneRaw || null,
      phone_e164: normalizePhoneE164(phoneRaw),
      email: String(rowObj.email || "").trim() || null,
      address: address || null,
      city: city || null,
      zip: zip || null,
      rank: String(rowObj.rank || "").trim() || null,
      jobs: Number.isFinite(jobs) ? jobs : null,
      removal_date: String(rowObj.removal_date || "").trim() || null,
      service: String(rowObj.service || "").trim() || null,
      removal_status: String(rowObj.removal || "").trim() || null,
      notes: String(rowObj.notes || "").trim() || null,
      christmas_card: csvTruthy(rowObj.christmas_card),
      in_bank_cents: inBankCents
    };
    customer.sort_score = christmasCustomerSortScore(customer);
    const locationParts = [customer.address, customer.city, customer.zip].filter(Boolean);
    customer.location_query = [...locationParts, "CA"].join(", ");
    out.push(customer);
  }
  out.sort((a, b) => Number(b.sort_score || 0) - Number(a.sort_score || 0));
  return out;
}

function readChristmasLightsCustomers() {
  const csvPath = resolveChristmasLightsCsvPath();
  if (!csvPath) return { rows: [], path: null, source: "missing" };
  try {
    const stat = fs.statSync(csvPath);
    if (
      CHRISTMAS_LIGHTS_DATA_CACHE.path === csvPath &&
      Number(CHRISTMAS_LIGHTS_DATA_CACHE.mtimeMs) === Number(stat.mtimeMs)
    ) {
      return {
        rows: Array.isArray(CHRISTMAS_LIGHTS_DATA_CACHE.rows) ? CHRISTMAS_LIGHTS_DATA_CACHE.rows : [],
        path: csvPath,
        source: "cache"
      };
    }
    const text = fs.readFileSync(csvPath, "utf8");
    const rows = parseChristmasLightsCsv(text);
    CHRISTMAS_LIGHTS_DATA_CACHE.path = csvPath;
    CHRISTMAS_LIGHTS_DATA_CACHE.mtimeMs = Number(stat.mtimeMs);
    CHRISTMAS_LIGHTS_DATA_CACHE.rows = rows;
    return { rows, path: csvPath, source: "csv" };
  } catch (e) {
    return { rows: [], path: csvPath, source: "error", error: String(e?.message || e) };
  }
}

async function resolveChristmasLightsCoordinates(customer, { allowGeocode = true } = {}) {
  const address = String(customer?.address || "").trim();
  const city = String(customer?.city || "").trim();
  const zip = String(customer?.zip || "").trim();
  const cacheKey = `${address}|${city}|${zip}`;
  const cached = CHRISTMAS_LIGHTS_GEO_CACHE.get(cacheKey);
  if (cached && Number.isFinite(Number(cached.lat)) && Number.isFinite(Number(cached.lng))) {
    return { ...cached, from_cache: true };
  }
  if (allowGeocode && (address || city || zip)) {
    try {
      const q = [address, city, zip, "CA"].filter(Boolean).join(", ");
      const geo = await geocodeOSM(q);
      if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
        const out = { lat: Number(geo.lat), lng: Number(geo.lon), source: "osm" };
        CHRISTMAS_LIGHTS_GEO_CACHE.set(cacheKey, out);
        return { ...out, from_cache: false };
      }
    } catch {}
  }
  if (zip && ZIP_CENTROIDS[zip]) {
    const out = { lat: Number(ZIP_CENTROIDS[zip].lat), lng: Number(ZIP_CENTROIDS[zip].lng), source: "zip_fallback" };
    CHRISTMAS_LIGHTS_GEO_CACHE.set(cacheKey, out);
    return { ...out, from_cache: false };
  }
  return null;
}

function looksLikeVoiceWebhook(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const callSid = String(p.CallSid || p.CallSidFallback || "").trim();
  const direction = String(p.Direction || "").toLowerCase();
  const hasVoiceFields =
    !!callSid ||
    !!String(p.Called || "").trim() ||
    !!String(p.Caller || "").trim() ||
    !!String(p.CallStatus || "").trim() ||
    direction.includes("voice");
  return hasVoiceFields;
}

function voiceFromPhone(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  return normalizePhoneE164(p.From || p.Caller || p.from || "") || String(p.From || p.Caller || p.from || "").trim() || null;
}

function voiceToPhone(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  return normalizePhoneE164(p.To || p.Called || p.to || "") || String(p.To || p.Called || p.to || "").trim() || null;
}

async function captureInboundCallLead(payload, eventType = "inbound_call_received") {
  const fromPhone = voiceFromPhone(payload);
  if (!fromPhone) return null;
  const toPhone = voiceToPhone(payload);
  const ts = new Date().toISOString();
  const callSid = String(payload?.CallSid || payload?.CallSidFallback || "").trim() || null;
  const callStatus = String(payload?.CallStatus || payload?.CallStatusFallback || "").trim().toLowerCase() || null;
  try {
    await pool.query(
      `INSERT INTO leads (
         from_phone, to_phone, first_seen_at, last_seen_at,
         last_event, last_body, num_media, media_url0, status, lead_source
       ) VALUES ($1,$2,$3,$3,$4,$5,0,NULL,'call','call')
       ON CONFLICT(from_phone) DO UPDATE SET
         to_phone = COALESCE(EXCLUDED.to_phone, leads.to_phone),
         last_seen_at = EXCLUDED.last_seen_at,
         last_event = COALESCE(EXCLUDED.last_event, leads.last_event),
         last_body = COALESCE(EXCLUDED.last_body, leads.last_body),
         status = 'call',
         lead_source = CASE
           WHEN LOWER(COALESCE(leads.lead_source,'')) IN ('', 'sms') THEN 'call'
           ELSE leads.lead_source
         END`,
      [fromPhone, toPhone, ts, callStatus ? `call_${callStatus}` : "call_inbound", callSid || null]
    );
  } catch {}
  try {
    insertEvent.run({
      from_phone: fromPhone,
      event_type: eventType,
      payload_json: JSON.stringify({
        call_sid: callSid,
        call_status: callStatus,
        direction: String(payload?.Direction || "").toLowerCase() || null,
        from: fromPhone,
        to: toPhone,
        payload
      }),
      created_at: ts
    });
  } catch {}
  try {
    await pool.query(
      `UPDATE leads
         SET last_seen_at = NOW(),
             status = COALESCE(status, 'call'),
             lead_source = CASE
               WHEN LOWER(COALESCE(lead_source, '')) IN ('', 'sms') THEN 'call'
               ELSE lead_source
             END
       WHERE from_phone = $1`,
      [fromPhone]
    );
  } catch {}
  return { fromPhone, toPhone, callSid, callStatus };
}

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function callVoicemailTwiml() {
  const l1 = "Hi, you've reached ICL Junk Removal.";
  const l2 = "Please leave a short message with your name, address, and what you need removed.";
  const l3 = "We'll text you right after this call so you can send photos for an accurate quote.";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say voice="alice">${escapeXml(l1)}</Say>` +
    `<Say voice="alice">${escapeXml(l2)}</Say>` +
    `<Say voice="alice">${escapeXml(l3)}</Say>` +
    `<Record maxLength="120" playBeep="true" trim="trim-silence" />` +
    `<Say voice="alice">Thanks. We'll be in touch shortly.</Say>` +
    `<Hangup/>` +
    `</Response>`
  );
}

async function hasRecentCallFollowupEvent(fromPhone, callSid, maxAgeMs = 30 * 60 * 1000) {
  if (!fromPhone) return false;
  try {
    const rows = (
      await pool.query(
        `SELECT payload_json, created_at
         FROM events
         WHERE from_phone = $1
           AND event_type = 'call_text_followup_sent'
         ORDER BY id DESC
         LIMIT 8`,
        [fromPhone]
      )
    ).rows;
    const now = Date.now();
    for (const row of rows) {
      const createdMs = new Date(row.created_at || 0).getTime();
      let payload = {};
      try { payload = JSON.parse(row.payload_json || "{}"); } catch {}
      if (callSid && String(payload.call_sid || "") === String(callSid)) return true;
      if (Number.isFinite(createdMs) && now - createdMs < maxAgeMs) return true;
    }
  } catch {}
  return false;
}

async function sendCallFollowupSms(payload, source = "voice_webhook") {
  const fromPhone = voiceFromPhone(payload);
  if (!fromPhone) return { ok: false, reason: "missing_from" };
  const callSid = String(payload?.CallSid || payload?.CallSidFallback || "").trim() || null;
  if (await hasRecentCallFollowupEvent(fromPhone, callSid)) {
    return { ok: true, skipped: true };
  }
  const sms = await sendSms(fromPhone, CALL_FOLLOWUP_SMS);
  try {
    insertEvent.run({
      from_phone: fromPhone,
      event_type: "call_text_followup_sent",
      payload_json: JSON.stringify({
        call_sid: callSid,
        source,
        twilio: sms
      }),
      created_at: new Date().toISOString()
    });
  } catch {}
  return { ok: true, skipped: false, twilio: sms };
}

async function notifyOpsNewCall(captured, source = "voice_webhook") {
  const fromPhone = String(captured?.fromPhone || "").trim();
  if (!fromPhone) return;
  try {
    const existing = (
      await pool.query(
        `SELECT id
         FROM events
         WHERE from_phone = $1
           AND event_type = 'ops_notified_inbound_call'
         ORDER BY id DESC
         LIMIT 1`,
        [fromPhone]
      )
    ).rows[0];
    if (existing) return;
  } catch {}
  try {
    await sendSms(
      OPS_ALERT_PHONE,
      `📞 NEW INBOUND CALL\n${fromPhone}\nSource: ${source}\nLead captured in WorldView.`
    );
    insertEvent.run({
      from_phone: fromPhone,
      event_type: "ops_notified_inbound_call",
      payload_json: JSON.stringify({
        source,
        call_sid: captured?.callSid || null,
        to: captured?.toPhone || null
      }),
      created_at: new Date().toISOString()
    });
  } catch {}
}

function parseJsonArrayText(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safePhonePathPart(phone) {
  return String(phone || "").replace(/[^\d+]/g, "_").replace(/\+/g, "plus");
}

function normalizeImageMediaType(mt, fallbackName = "") {
  const low = String(mt || "").toLowerCase();
  const name = String(fallbackName || "").toLowerCase();
  if (low.includes("png") || name.endsWith(".png")) return "image/png";
  if (low.includes("webp") || name.endsWith(".webp")) return "image/webp";
  if (low.includes("heic") || low.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif")) return "image/heic";
  return "image/jpeg";
}

function dataUriForImage(buffer, mediaType) {
  return `data:${mediaType};base64,${Buffer.from(buffer).toString("base64")}`;
}

function parseDataUri(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

function renderableLeadMediaUrls(phone, mediaList, limit = 8) {
  const out = [];
  const src = Array.isArray(mediaList) ? mediaList : [];
  for (let i = 0; i < src.length; i++) {
    const u = String(src[i] || "").trim();
    if (!u) continue;
    if (u.startsWith("data:image/")) {
      out.push(`/lead-media/${encodeURIComponent(String(phone || ""))}/${i}`);
    } else if (/^https?:\/\//i.test(u) || u.startsWith("/public/")) {
      out.push(u);
    }
    if (out.length >= limit) break;
  }
  return out;
}

function extractVisionItemList(vision) {
  const src = Array.isArray(vision?.items) ? vision.items : [];
  const uniq = [];
  const seen = new Set();
  for (const raw of src) {
    const item = String(raw || "").trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(item);
    if (uniq.length >= 80) break;
  }
  return uniq.join("\n");
}

async function normalizeUploadedImage(file) {
  if (!file || !file.buffer || !file.originalname) return { ok: false, warning: "Unknown file skipped" };
  const baseMediaType = normalizeImageMediaType(file.mimetype, file.originalname);
  const isHeic = baseMediaType === "image/heic";
  if (!/^image\//.test(baseMediaType)) {
    return { ok: false, warning: `${file.originalname} — unsupported type` };
  }
  if (isHeic) {
    try {
      const jpg = await sharp(file.buffer).jpeg({ quality: 86 }).toBuffer();
      return {
        ok: true,
        mediaType: "image/jpeg",
        buffer: jpg,
        originalname: file.originalname.replace(/\.(heic|heif)$/i, ".jpg")
      };
    } catch {
      return { ok: false, warning: `${file.originalname} — HEIC not supported, please convert to JPEG` };
    }
  }
  return {
    ok: true,
    mediaType: baseMediaType,
    buffer: Buffer.from(file.buffer),
    originalname: file.originalname
  };
}

async function prepareLeadMediaStorage(files, phone) {
  const normalized = [];
  const warnings = [];
  for (const file of Array.isArray(files) ? files : []) {
    const out = await normalizeUploadedImage(file);
    if (!out.ok) {
      if (out.warning) warnings.push(out.warning);
      continue;
    }
    normalized.push(out);
  }
  if (!normalized.length) return { ok: false, warnings, storedMedia: [], analysisInputs: [] };

  const totalBytes = normalized.reduce((sum, f) => sum + Number(f.buffer?.length || 0), 0);
  const useInline = totalBytes <= MANUAL_MEDIA_INLINE_MAX_BYTES;
  const storedMedia = [];
  const analysisInputs = [];

  if (useInline) {
    for (const f of normalized) {
      const dataUri = dataUriForImage(f.buffer, f.mediaType);
      storedMedia.push(dataUri);
      analysisInputs.push(dataUri);
    }
    return { ok: true, warnings, storageMode: "inline", storedMedia, analysisInputs };
  }

  const uploadsDir = path.join(__dirname, "public", "uploads", safePhonePathPart(phone));
  fs.mkdirSync(uploadsDir, { recursive: true });
  const nowTag = Date.now();
  let idx = 0;
  for (const f of normalized) {
    idx += 1;
    const ext = f.mediaType.includes("png") ? ".png" : f.mediaType.includes("webp") ? ".webp" : ".jpg";
    const base = path.basename(String(f.originalname || "photo"), path.extname(String(f.originalname || "photo"))).replace(/[^\w.-]/g, "_").slice(0, 40) || "photo";
    const fileName = `${nowTag}-${idx}-${base}${ext}`;
    const abs = path.join(uploadsDir, fileName);
    fs.writeFileSync(abs, f.buffer);
    const publicUrl = `/public/uploads/${safePhonePathPart(phone)}/${fileName}`;
    storedMedia.push(publicUrl);
    analysisInputs.push(dataUriForImage(f.buffer, f.mediaType));
  }
  return { ok: true, warnings, storageMode: "public_url", storedMedia, analysisInputs };
}

async function runManualVisionAndPersist(phone, mediaList) {
  const lead = (await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [phone])).rows[0];
  if (!lead) throw new Error("Lead not found");
  const stored = Array.isArray(mediaList) ? mediaList : parseJsonArrayText(lead.media_urls);
  if (!stored.length) throw new Error("No photos available to analyze");

  const analysisInputs = [];
  for (const entry of stored.slice(0, MANUAL_MEDIA_MAX_FILES)) {
    const raw = String(entry || "").trim();
    if (!raw) continue;
    if (raw.startsWith("data:image/")) {
      analysisInputs.push(raw);
      continue;
    }
    if (raw.startsWith("/public/")) {
      const abs = path.join(__dirname, raw.replace(/^\/+/, ""));
      if (!fs.existsSync(abs)) continue;
      const buf = fs.readFileSync(abs);
      const mt = normalizeImageMediaType(path.extname(abs), abs);
      analysisInputs.push(dataUriForImage(buf, mt));
      continue;
    }
    if (/^https?:\/\//i.test(raw)) {
      try {
        const r = await fetch(raw);
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const mt = normalizeImageMediaType(r.headers.get("content-type") || "", raw);
        analysisInputs.push(dataUriForImage(buf, mt));
      } catch {}
    }
  }
  if (!analysisInputs.length) throw new Error("No analyzable photos found");

  const vision = await analyzeBase64Images(analysisInputs);
  const itemList = extractVisionItemList(vision);
  await pool.query(
    `UPDATE leads
     SET vision_analysis=$1,
         load_bucket=COALESCE($2,load_bucket),
         item_list=$3,
         media_urls=$4,
         has_media=CASE WHEN $5 > 0 THEN 1 ELSE has_media END,
         num_media=GREATEST(COALESCE(num_media,0), $5),
         last_seen_at=NOW()
     WHERE from_phone=$6`,
    [
      JSON.stringify(vision),
      vision.load_bucket || null,
      itemList || null,
      JSON.stringify(stored),
      stored.length,
      phone
    ]
  );
  const updatedLead = (await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [phone])).rows[0] || null;
  return { vision, updatedLead };
}

function extractMediaUrlsFromPayload(payload) {
  const out = [];
  if (!payload || typeof payload !== "object") return out;
  for (const [k, v] of Object.entries(payload)) {
    const key = String(k || "");
    if (!/mediaurl\d+/i.test(key) && key !== "media_url0" && key !== "mediaUrl0") continue;
    const u = String(v || "").trim();
    if (!u || !/^https?:\/\//i.test(u)) continue;
    if (!out.includes(u)) out.push(u);
  }
  if (Array.isArray(payload.media_urls)) {
    for (const v of payload.media_urls) {
      const u = String(v || "").trim();
      if (!u || !/^https?:\/\//i.test(u)) continue;
      if (!out.includes(u)) out.push(u);
    }
  }
  return out;
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
app.use(express.json({
  limit: "2mb",
  verify: (req, _res, buf) => {
    try {
      if (buf && buf.length) req.rawBody = buf.toString("utf8");
    } catch {}
  }
}))
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
  const headerPass = String(req.headers["x-admin-password"] || "").trim();
  if (headerPass && headerPass === ADMIN_PASSWORD) return next();
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
const KANBAN_COLS = ["critical", "inprogress", "upcoming", "done"];
const planningState = {
  kanban: {
    critical: [],
    inprogress: [],
    upcoming: [],
    done: []
  },
  updated_at: null
};

let baseGeo = null;

function normalizeKanban(input) {
  const out = { critical: [], inprogress: [], upcoming: [], done: [] };
  const src = input && typeof input === "object" ? input : {};
  for (const col of KANBAN_COLS) {
    const rows = Array.isArray(src[col]) ? src[col] : [];
    out[col] = rows
      .map((r, idx) => {
        const title = String(r?.title || "").trim();
        if (!title) return null;
        const id = String(r?.id || `k${Date.now()}${idx}${Math.floor(Math.random() * 1000)}`).trim();
        const tagRaw = String(r?.tag || "sys").toLowerCase();
        const tag = ["sys", "biz", "dat", "grow"].includes(tagRaw) ? tagRaw : "sys";
        return {
          id,
          title,
          note: String(r?.note || "").trim(),
          tag
        };
      })
      .filter(Boolean);
  }
  return out;
}

function buildRoadmapFromKanban(kanban) {
  const safe = normalizeKanban(kanban);
  const now = [...safe.critical, ...safe.inprogress].map((c) => ({ ...c }));
  const next = safe.upcoming.slice(0, 4).map((c) => ({ ...c }));
  const later = safe.upcoming.slice(4).map((c) => ({ ...c }));
  const released = safe.done.map((c) => ({ ...c }));
  return { now, next, later, released };
}

function planningPayload(message) {
  return {
    ok: true,
    ...(message ? { message } : {}),
    kanban: planningState.kanban,
    roadmap: buildRoadmapFromKanban(planningState.kanban),
    updated_at: planningState.updated_at
  };
}

function applyPlanningMutation(nextKanban) {
  planningState.kanban = normalizeKanban(nextKanban);
  planningState.updated_at = new Date().toISOString();
}

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

function bookingDayOptions(days = 7, { sameDayMinLeadHours = 0 } = {}) {
  const now = new Date();
  const out = [];
  let cursor = 0;
  const maxLookahead = Math.max(days + 7, 21);
  while (out.length < days && cursor < maxLookahead) {
    const d = new Date(now);
    d.setDate(now.getDate() + cursor);
    if (cursor === 0 && Number(sameDayMinLeadHours) > 0) {
      const hour = d.getHours() + (d.getMinutes() / 60);
      const hoursLeft = Math.max(0, 24 - hour);
      if (hoursLeft < Number(sameDayMinLeadHours)) {
        cursor += 1;
        continue;
      }
    }
    const iso = toIsoDate(d);
    const label = dayLabelFromIso(iso);
    if (label) out.push({ iso, label });
    cursor += 1;
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
    let worldviewByPhone = new Map();
    try {
      const worldviewLeads = await listWorldviewLeads({ limit });
      worldviewByPhone = new Map(
        worldviewLeads
          .map((l) => [String(l.phone || ""), l])
          .filter(([phone]) => !!phone)
      );
    } catch {}

    const rows = (
      await pool.query(
        `SELECT
           from_phone,
           first_seen_at,
           last_seen_at,
           address_text,
           zip,
           zip_text,
           media_url0,
           load_bucket,
           quote_status,
           conv_state,
           deposit_paid,
           timing_pref,
           quote_total_cents,
           quoted_amount,
           has_media,
           num_media,
           vision_analysis,
           lead_name,
           lead_email,
           notes,
           site_visit_date,
           lead_source,
           item_list,
           media_urls,
           square_payment_link_url,
           square_upfront_payment_link_url
         FROM leads
         ORDER BY
           CASE WHEN LOWER(COALESCE(lead_source,'sms'))='manual' THEN 0 ELSE 1 END,
           last_seen_at DESC NULLS LAST
         LIMIT $1`,
        [limit]
      )
    ).rows;

    const phones = rows.map((r) => String(r.from_phone || "")).filter(Boolean);
    const actionCounts = new Map();
    const itemTableByPhone = new Map();
    const mediaByPhone = new Map();
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

      try {
        const itemRows = (
          await pool.query(
            `SELECT from_phone, UPPER(COALESCE(bucket,'DUMP')) AS bucket,
                    ARRAY_REMOVE(ARRAY_AGG(item_name ORDER BY id DESC), NULL) AS names
             FROM job_items
             WHERE from_phone = ANY($1)
             GROUP BY from_phone, UPPER(COALESCE(bucket,'DUMP'))`,
            [phones]
          )
        ).rows;
        for (const r of itemRows) {
          const phone = String(r.from_phone || "");
          if (!phone) continue;
          const rec = itemTableByPhone.get(phone) || { resale: [], donate: [], dump: [], scrap: [] };
          const bucket = String(r.bucket || "");
          const key =
            bucket === "RESELL" ? "resale" :
            bucket === "DONATE" ? "donate" :
            bucket === "SCRAP" ? "scrap" :
            "dump";
          const names = Array.isArray(r.names) ? r.names : [];
          for (const name of names) {
            const item = String(name || "").trim();
            if (!item || rec[key].includes(item)) continue;
            rec[key].push(item);
            if (rec[key].length >= 8) break;
          }
          itemTableByPhone.set(phone, rec);
        }
      } catch {}

      try {
        const mediaRows = (
          await pool.query(
            `SELECT from_phone, payload_json
             FROM events
             WHERE from_phone = ANY($1)
               AND event_type = ANY($2)
             ORDER BY id DESC
             LIMIT 5000`,
            [phones, ["inbound_raw", "media_received", "media_backfill_hit"]]
          )
        ).rows;
        for (const r of mediaRows) {
          const phone = String(r.from_phone || "");
          if (!phone) continue;
          const rec = mediaByPhone.get(phone) || [];
          if (rec.length >= 8) continue;
          const payload = safeJsonParse(r.payload_json) || {};
          const urls = extractMediaUrlsFromPayload(payload);
          for (const u of urls) {
            if (!rec.includes(u)) rec.push(u);
            if (rec.length >= 8) break;
          }
          mediaByPhone.set(phone, rec);
        }
      } catch {}
    }

    const leads = rows.map((r) => {
      const phone = String(r.from_phone || "");
      const state = leadState(r);
      const worldview = worldviewByPhone.get(phone) || null;
      const itemTable = itemTableByPhone.get(phone) || { resale: [], donate: [], dump: [], scrap: [] };
      const mediaUrls = [...(mediaByPhone.get(phone) || [])];
      const storedMediaRaw = parseJsonArrayText(r.media_urls);
      const storedPreviewUrls = renderableLeadMediaUrls(phone, storedMediaRaw, 8);
      for (const u of storedPreviewUrls) {
        if (!mediaUrls.includes(u)) mediaUrls.push(u);
      }
      if (r.media_url0 && !mediaUrls.includes(r.media_url0)) mediaUrls.unshift(String(r.media_url0));
      const vision = safeJsonParse(r.vision_analysis) || {};
      const visionBuckets = extractVisionBuckets(vision, { limitPerBucket: 8 });
      itemTable.resale = mergeUniqueStrings(itemTable.resale, visionBuckets.resell_items, 8);
      itemTable.donate = mergeUniqueStrings(itemTable.donate, visionBuckets.donate_items, 8);
      itemTable.dump = mergeUniqueStrings(itemTable.dump, visionBuckets.dump_items, 8);
      itemTable.scrap = mergeUniqueStrings(itemTable.scrap, visionBuckets.scrap_items, 8);
      const mergedIntel = {
        ...(worldview?.hover || {}),
        item_table: {
          resale: itemTable.resale.slice(0, 8),
          donate: itemTable.donate.slice(0, 8),
          dump: itemTable.dump.slice(0, 8),
          scrap: itemTable.scrap.slice(0, 8)
        },
        media_urls: mediaUrls.slice(0, 8)
      };
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
        quote_amount: Number.isFinite(Number(r.quote_total_cents))
          ? Number(r.quote_total_cents)
          : (Number.isFinite(Number(r.quoted_amount)) ? Number(r.quoted_amount) : null),
        deposit_paid: Number(r.deposit_paid) === 1,
        lead_name: String(r.lead_name || "").trim() || null,
        lead_email: String(r.lead_email || "").trim() || null,
        notes: String(r.notes || "").trim() || null,
        site_visit_date: String(r.site_visit_date || "").trim() || null,
        lead_source: normalizeLeadSource(r.lead_source || "sms"),
        quoted_amount_cents: Number.isFinite(Number(r.quoted_amount)) ? Number(r.quoted_amount) : null,
        item_list: String(r.item_list || "").trim() || null,
        vision_analysis: r.vision_analysis || null,
        square_payment_link_url: r.square_payment_link_url || null,
        square_upfront_payment_link_url: r.square_upfront_payment_link_url || null,
        settled_revenue_cents: null,
        total_cost_cents: null,
        margin_cents: null,
        margin_pct: null,
        next_action_sent_count: Number(actionCounts.get(phone) || 0),
        intel: mergedIntel,
        item_table: mergedIntel.item_table,
        media_urls: mergedIntel.media_urls
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
      const stageWeight = stage === "lead" ? 90 : stage === "deposit" ? 65 : stage === "paid" ? 40 : 20;
      const riskWeight = risk === "high" ? 30 : risk === "medium" ? 15 : 0;
      const priorityScore = stageWeight + riskWeight + Math.min(120, Math.floor(inactivityMinutes / 5));
      pins.push({
        phone: lead.phone,
        address: lead.address,
        lead_name: lead.lead_name || null,
        lead_source: lead.lead_source || "sms",
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
        priority_score: priorityScore,
        intel: lead.intel || null,
        item_table: lead.item_table || { resale: [], donate: [], dump: [], scrap: [] },
        media_urls: lead.media_urls || []
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

    const stageCounts = { lead: 0, deposit: 0, paid: 0, completed: 0 };
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
    const slaRedCount = pins.filter((p) => Number(p.inactivity_minutes || 0) >= 120 && p.stage !== "completed").length;
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

app.get("/api/dashboard/opportunities", async (_req, res) => {
  const permits = [
    { title: "Demo permit cluster", subtitle: "Turnover cleanouts likely", lat: 34.0069, lng: -118.3462 },
    { title: "Remodel permit cluster", subtitle: "Post-project debris opportunity", lat: 33.9862, lng: -118.3528 }
  ];
  const housing = [
    { title: "Multifamily turnover", subtitle: "Move-out pulse", lat: 33.9776, lng: -118.3334 },
    { title: "Senior move activity", subtitle: "Downsize transition", lat: 33.9922, lng: -118.3658 }
  ];
  const transit = [
    {
      title: "Transit corridor works",
      subtitle: "Temporary displacement risk",
      path: [
        { lat: 33.946, lng: -118.341 },
        { lat: 33.975, lng: -118.339 },
        { lat: 34.008, lng: -118.334 }
      ]
    }
  ];
  const corridors = [
    {
      title: "Retail corridor pressure",
      subtitle: "Vacancy cleanout signal",
      path: [
        { lat: 33.986, lng: -118.392 },
        { lat: 33.989, lng: -118.364 },
        { lat: 33.992, lng: -118.334 }
      ]
    }
  ];
  return res.json({
    ok: true,
    permits,
    housing,
    corridors,
    transit,
    meta: {
      generated_at: new Date().toISOString(),
      source: "fallback_seeded"
    }
  });
});

app.get("/api/dashboard/planning", (_req, res) => {
  return res.json(planningPayload());
});

app.put("/api/dashboard/planning", (req, res) => {
  try {
    applyPlanningMutation(req.body?.kanban || {});
    return res.json(planningPayload("Saved"));
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/dashboard/planning/idea", (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const note = String(req.body?.note || "").trim();
    const tagRaw = String(req.body?.tag || "sys").toLowerCase();
    const targetRaw = String(req.body?.target || "upcoming").toLowerCase();
    const tag = ["sys", "biz", "dat", "grow"].includes(tagRaw) ? tagRaw : "sys";
    const target = KANBAN_COLS.includes(targetRaw) ? targetRaw : "upcoming";
    if (!title) return res.status(400).json({ ok: false, error: "title_required" });
    const id = `k${Date.now()}${Math.floor(Math.random() * 1000)}`;
    planningState.kanban[target].unshift({ id, title, note, tag });
    planningState.updated_at = new Date().toISOString();
    return res.json(planningPayload("Idea added"));
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/dashboard/planning/command", (req, res) => {
  try {
    const raw = String(req.body?.command || "").trim();
    if (!raw) return res.status(400).json({ ok: false, error: "command_required" });
    const m = raw.match(/^\/([a-z_]+)\b/i);
    const cmd = m ? String(m[1]).toLowerCase() : "";
    const args = {};
    for (const part of raw.replace(/^\/[a-z_]+\s*/i, "").match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
      const kv = part.match(/^([a-z_]+)=(.+)$/i);
      if (!kv) continue;
      const k = String(kv[1]).toLowerCase();
      let v = String(kv[2] || "");
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      args[k] = v;
    }
    const findCard = (id) => {
      for (const col of KANBAN_COLS) {
        const idx = planningState.kanban[col].findIndex((c) => c.id === id);
        if (idx >= 0) return { col, idx, card: planningState.kanban[col][idx] };
      }
      return null;
    };
    let message = "Done";
    if (cmd === "list") {
      message = "Listed";
    } else if (cmd === "idea") {
      const title = String(args.title || "").trim();
      if (!title) return res.status(400).json({ ok: false, error: "title_required" });
      const target = KANBAN_COLS.includes(String(args.target || "").toLowerCase())
        ? String(args.target || "").toLowerCase()
        : "upcoming";
      const tag = ["sys", "biz", "dat", "grow"].includes(String(args.tag || "").toLowerCase())
        ? String(args.tag || "").toLowerCase()
        : "sys";
      planningState.kanban[target].unshift({
        id: `k${Date.now()}${Math.floor(Math.random() * 1000)}`,
        title,
        note: String(args.note || "").trim(),
        tag
      });
      message = "Idea added";
    } else if (cmd === "move" || cmd === "start" || cmd === "ship" || cmd === "reopen" || cmd === "delete") {
      const id = String(args.id || "").trim();
      if (!id) return res.status(400).json({ ok: false, error: "id_required" });
      const found = findCard(id);
      if (!found) return res.status(404).json({ ok: false, error: "card_not_found" });
      planningState.kanban[found.col].splice(found.idx, 1);
      if (cmd === "delete") {
        message = "Deleted";
      } else {
        const to =
          cmd === "start" ? "inprogress" :
          cmd === "ship" ? "done" :
          cmd === "reopen" ? "upcoming" :
          (KANBAN_COLS.includes(String(args.to || "").toLowerCase()) ? String(args.to || "").toLowerCase() : found.col);
        planningState.kanban[to].unshift(found.card);
        message = `Moved to ${to}`;
      }
    } else {
      return res.status(400).json({ ok: false, error: "unknown_command" });
    }
    planningState.updated_at = new Date().toISOString();
    return res.json(planningPayload(message));
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
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

app.get("/api/dashboard/christmas-lights", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 240) || 240));
    const geocodeBudget = Math.max(0, Math.min(120, Number(req.query.geocode_budget || 30) || 30));
    const loaded = readChristmasLightsCustomers();
    const baseRows = Array.isArray(loaded.rows) ? loaded.rows : [];
    const rows = baseRows.slice(0, limit);
    const points = [];
    let geocodedFresh = 0;
    for (const customer of rows) {
      const canGeocode = geocodedFresh < geocodeBudget;
      const coords = await resolveChristmasLightsCoordinates(customer, { allowGeocode: canGeocode });
      if (!coords) continue;
      if (!coords.from_cache && coords.source === "osm") geocodedFresh += 1;
      points.push({
        ...customer,
        lat: Number(coords.lat),
        lng: Number(coords.lng),
        geo_source: coords.source
      });
    }
    return res.json({
      ok: true,
      customers: rows,
      points,
      meta: {
        generated_at: new Date().toISOString(),
        source: loaded.path ? "csv" : "missing",
        csv_file: loaded.path ? path.basename(loaded.path) : null,
        total_rows: baseRows.length,
        returned_rows: rows.length,
        mapped_points: points.length,
        geocode_budget: geocodeBudget,
        geocoded_fresh: geocodedFresh
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
    const days = bookingDayOptions(5, { sameDayMinLeadHours: 4 });
    const dayMatrix = await Promise.all(
      days.map(async (d) => {
        let booked = [];
        try {
          booked = await getBookedWindows(d.iso);
        } catch {}
        const bookedSet = new Set((Array.isArray(booked) ? booked : []).map((w) => String(w || "").trim()));
        const windows = BOOKING_WINDOWS.map((w) => ({
          label: w,
          available: !bookedSet.has(w)
        }));
        return {
          iso: d.iso,
          label: d.label,
          windows,
          has_available: windows.some((w) => w.available)
        };
      })
    );
    const safeDayMatrixJson = JSON.stringify(dayMatrix)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026");
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
    :root{
      --icl-green:#1B5E20;
      --icl-gold:#F9A825;
      --slate-900:#0f172a;
      --slate-700:#334155;
      --slate-500:#64748b;
      --slate-300:#cbd5e1;
      --slate-200:#e2e8f0;
      --slate-100:#f1f5f9;
    }
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;padding:16px;color:var(--slate-900)}
    .card{max-width:480px;margin:0 auto;background:#fff;border:1px solid var(--slate-200);border-radius:16px;overflow:hidden;box-shadow:0 12px 30px rgba(2,6,23,.1)}
    .hero{background:linear-gradient(135deg,#0f766e,#134e4a);padding:16px;color:#f0fdfa}
    .brand{display:flex;align-items:center;gap:10px}
    .logo{width:34px;height:34px;border-radius:8px;object-fit:cover;border:1px solid rgba(255,255,255,.45);background:#fff}
    .brand-text{font-size:12px;letter-spacing:.5px;text-transform:uppercase;opacity:.95}
    h1{margin:8px 0 4px;font-size:34px;line-height:1.05;font-weight:900}
    .hero p{margin:0;color:#d1fae5;font-size:17px}
    .body{padding:14px}
    .pill{display:inline-block;background:var(--slate-100);border:1px solid var(--slate-300);border-radius:999px;padding:6px 10px;font-size:12px;color:var(--slate-700);margin-bottom:10px}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
    .meta .m{background:#f8fafc;border:1px solid var(--slate-200);border-radius:10px;padding:8px 10px;font-size:13px}
    .small{font-size:12px;color:var(--slate-500);margin:0 0 10px}
    .label{font-size:13px;color:var(--slate-700);font-weight:700;margin:8px 0 6px}
    .day-row{display:flex;gap:8px;overflow:auto;padding-bottom:4px}
    .day-card{min-width:86px;border:1px solid var(--slate-300);border-radius:12px;background:#fff;padding:10px 8px;text-align:center;color:var(--slate-700);cursor:pointer}
    .day-card .d1{font-size:11px;text-transform:uppercase;letter-spacing:.4px}
    .day-card .d2{font-size:17px;font-weight:800;line-height:1.1;margin-top:3px}
    .day-card.selected{border-color:var(--icl-green);background:#ecfdf3;color:var(--icl-green)}
    .day-card.disabled{background:#f8fafc;color:#94a3b8;border-color:#e2e8f0;cursor:not-allowed}
    .window-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .wbtn{border:1px solid var(--slate-300);border-radius:999px;padding:10px;background:#fff;color:var(--slate-700);font-size:14px;font-weight:600;cursor:pointer}
    .wbtn.selected{border-color:var(--icl-green);background:#ecfdf3;color:var(--icl-green)}
    .wbtn.disabled{background:#f1f5f9;border-color:#e2e8f0;color:#94a3b8;cursor:not-allowed}
    .wbtn small{display:block;font-size:10px;font-weight:700;color:#94a3b8;letter-spacing:.4px}
    .cta{margin-top:12px;width:100%;padding:14px;border-radius:12px;border:none;background:var(--icl-green);color:#fff;font-weight:800;font-size:17px;cursor:pointer}
    .cta:disabled{background:#94a3b8;cursor:not-allowed}
    .ok{margin-top:10px;color:#166534;font-weight:800;font-size:15px}
    .err{margin-top:10px;color:#b91c1c;font-weight:700}
    .foot{margin-top:12px;padding-top:10px;border-top:1px solid var(--slate-200)}
    .muted{font-size:12px;color:var(--slate-500)}
    @media(max-width:430px){
      h1{font-size:30px}
      .window-grid{grid-template-columns:1fr}
      .meta{grid-template-columns:1fr}
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="hero">
      <div class="brand">
        <img class="logo" src="/public/logo.jpg" alt="ICL logo" />
        <div class="brand-text">ICL Junk Removal</div>
      </div>
      <h1>Choose Your Arrival Window</h1>
      <p>You’re confirmed. This is the final step to lock your schedule.</p>
    </div>
    <div class="body">
      ${confirmation}
      <div class="meta">
        <div class="m"><strong>Phone</strong><br>${escHtml(parsed.phone)}</div>
        <div class="m"><strong>Address</strong><br>${escHtml(lead.address_text || "On file")}</div>
      </div>
      <p class="small">You should have received your Square receipt. Pick a day + arrival window below.</p>
      <form id="book-form">
        <input type="hidden" name="token" value="${escHtml(req.params.token)}" />
        <input type="hidden" id="day_iso" name="day_iso" />
        <input type="hidden" id="window" name="window" />
        <div class="label">Choose day</div>
        <div id="day-row" class="day-row"></div>
        <div class="label" style="margin-top:10px">Choose arrival window</div>
        <div id="window-row" class="window-grid"></div>
        <button id="book-btn" class="cta" type="submit" disabled>Confirm my appointment</button>
        <div id="book-msg"></div>
      </form>
      <div class="foot">
        <p class="muted">Need help? Reply HELP to our text and we’ll assist.</p>
      </div>
    </div>
  </div>
  <script>
    const DAY_MATRIX = ${safeDayMatrixJson};
    const form=document.getElementById('book-form');
    const msg=document.getElementById('book-msg');
    const btn=document.getElementById('book-btn');
    const dayRow=document.getElementById('day-row');
    const windowRow=document.getElementById('window-row');
    const dayInput=document.getElementById('day_iso');
    const winInput=document.getElementById('window');
    let selectedDay=null;
    let selectedWindow=null;

    function dayParts(label){
      const p=String(label||'').split(' ');
      return { dow:(p[0]||'').toUpperCase(), md:[p[1],p[2]].filter(Boolean).join(' ') };
    }
    function currentDayObj(){ return DAY_MATRIX.find(d=>d.iso===selectedDay)||null; }
    function updateCta(){
      const dayObj=currentDayObj();
      const hasAvail=!!(dayObj&&dayObj.windows&&dayObj.windows.some(w=>w.available));
      btn.disabled=!(selectedDay&&selectedWindow&&hasAvail);
      dayInput.value=selectedDay||'';
      winInput.value=selectedWindow||'';
    }
    function renderDays(){
      dayRow.innerHTML='';
      DAY_MATRIX.forEach(d=>{
        const parts=dayParts(d.label);
        const b=document.createElement('button');
        b.type='button';
        b.className='day-card'+(d.iso===selectedDay?' selected':'')+(!d.has_available?' disabled':'');
        b.innerHTML='<div class="d1">'+parts.dow+'</div><div class="d2">'+parts.md+'</div>';
        if(!d.has_available){
          const f=document.createElement('div');
          f.style.cssText='font-size:10px;margin-top:4px;opacity:.8';
          f.textContent='No slots';
          b.appendChild(f);
        }
        b.addEventListener('click',()=>{
          if(!d.has_available)return;
          selectedDay=d.iso;
          selectedWindow=null;
          renderDays();
          renderWindows();
          updateCta();
        });
        dayRow.appendChild(b);
      });
    }
    function renderWindows(){
      windowRow.innerHTML='';
      const dayObj=currentDayObj();
      if(!dayObj){
        windowRow.innerHTML='<div class="muted" style="grid-column:1/-1">Select a day to see available windows.</div>';
        return;
      }
      dayObj.windows.forEach(w=>{
        const b=document.createElement('button');
        b.type='button';
        b.className='wbtn'+(selectedWindow===w.label?' selected':'')+(!w.available?' disabled':'');
        b.innerHTML='<span>'+w.label.replace('-', '–')+'</span>'+(w.available?'':'<small>BOOKED</small>');
        b.addEventListener('click',()=>{
          if(!w.available)return;
          selectedWindow=w.label;
          renderWindows();
          updateCta();
        });
        windowRow.appendChild(b);
      });
    }
    const firstAvailable = DAY_MATRIX.find(d=>d.has_available);
    if(firstAvailable){ selectedDay=firstAvailable.iso; }
    renderDays();
    renderWindows();
    updateCta();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className=''; msg.textContent='';
      btn.disabled=true;
      try{
        const payload={
          token: form.token.value,
          day_iso: dayInput.value,
          window: winInput.value
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
        updateCta();
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
  const fromPhone = payload.From || payload.from || payload.Caller || "unknown";
  const ts = new Date().toISOString();

  // Some deployments still point Twilio Voice to /twilio/inbound.
  // Detect voice payloads here so call-first leads are still captured.
  if (looksLikeVoiceWebhook(payload)) {
    res.set("Content-Type", "text/xml");
    res.send(callVoicemailTwiml());
    (async () => {
      try {
        const captured = await captureInboundCallLead(payload, "inbound_call_received");
        if (captured?.fromPhone) {
          try {
            await sendCallFollowupSms(payload, "inbound_voice_fallback");
          } catch (smsErr) {
            insertEvent.run({
              from_phone: captured.fromPhone,
              event_type: "call_text_followup_failed",
              payload_json: JSON.stringify({
                source: "inbound_voice_fallback",
                call_sid: captured.callSid || null,
                error: String(smsErr?.message || smsErr)
              }),
              created_at: new Date().toISOString()
            });
          }
        }
      } catch (e) {
        try {
          insertEvent.run({
            from_phone: voiceFromPhone(payload) || "unknown",
            event_type: "twilio_voice_capture_error",
            payload_json: JSON.stringify({ error: String(e?.message || e), payload }),
            created_at: new Date().toISOString()
          });
        } catch {}
      }
    })();
    return;
  }

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

app.post("/twilio/voice", async (req, res) => {
  const payload = req.body || {};
  res.set("Content-Type", "text/xml");
  res.send(callVoicemailTwiml());

  try {
    const captured = await captureInboundCallLead(payload, "inbound_call_received");
    if (captured?.fromPhone) {
      try {
        await sendCallFollowupSms(payload, "voice_webhook");
      } catch (smsErr) {
        insertEvent.run({
          from_phone: captured.fromPhone,
          event_type: "call_text_followup_failed",
          payload_json: JSON.stringify({
            source: "voice_webhook",
            call_sid: captured.callSid || null,
            error: String(smsErr?.message || smsErr)
          }),
          created_at: new Date().toISOString()
        });
      }
    }
  } catch (e) {
    try {
      insertEvent.run({
        from_phone: voiceFromPhone(payload) || "unknown",
        event_type: "twilio_voice_capture_error",
        payload_json: JSON.stringify({ error: String(e?.message || e), payload }),
        created_at: new Date().toISOString()
      });
    } catch {}
  }
});

app.post("/twilio/voice/status", async (req, res) => {
  const payload = req.body || {};
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
  try {
    const captured = await captureInboundCallLead(payload, "inbound_call_status");
    const callStatus = String(payload?.CallStatus || "").toLowerCase();
    if (captured?.fromPhone && ["no-answer", "busy", "failed", "canceled"].includes(callStatus)) {
      try {
        await sendCallFollowupSms(payload, "voice_status_callback");
      } catch (smsErr) {
        insertEvent.run({
          from_phone: captured.fromPhone,
          event_type: "call_text_followup_failed",
          payload_json: JSON.stringify({
            source: "voice_status_callback",
            call_sid: captured.callSid || null,
            call_status: callStatus,
            error: String(smsErr?.message || smsErr)
          }),
          created_at: new Date().toISOString()
        });
      }
    }
  } catch (e) {
    try {
      insertEvent.run({
        from_phone: voiceFromPhone(payload) || "unknown",
        event_type: "twilio_voice_status_error",
        payload_json: JSON.stringify({ error: String(e?.message || e), payload }),
        created_at: new Date().toISOString()
      });
    } catch {}
  }
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

app.get("/lead-media/:from/:idx", async (req, res) => {
  try {
    const fromPhone = normalizePhoneE164(req.params.from || "");
    const idx = Number(req.params.idx);
    if (!fromPhone || !Number.isInteger(idx) || idx < 0) return res.status(400).send("bad_request");
    const lead = (await pool.query("SELECT media_urls FROM leads WHERE from_phone=$1 LIMIT 1", [fromPhone])).rows[0];
    if (!lead) return res.status(404).send("not_found");
    const media = parseJsonArrayText(lead.media_urls);
    const raw = String(media[idx] || "").trim();
    if (!raw) return res.status(404).send("not_found");
    const data = parseDataUri(raw);
    if (data) {
      res.setHeader("Content-Type", data.mediaType || "image/jpeg");
      return res.end(Buffer.from(data.base64, "base64"));
    }
    if (/^https?:\/\//i.test(raw)) return res.redirect(raw);
    if (raw.startsWith("/public/")) {
      const abs = path.join(__dirname, raw.replace(/^\/+/, ""));
      if (!abs.startsWith(path.join(__dirname, "public"))) return res.status(403).send("forbidden");
      if (!fs.existsSync(abs)) return res.status(404).send("not_found");
      return res.sendFile(abs);
    }
    return res.status(404).send("not_found");
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

app.get("/admin/leads", async (_req, res) => {
  try {
    const rows = (
      await pool.query(
        `SELECT
           from_phone,
           lead_name,
           lead_source,
           quoted_amount,
           site_visit_date,
           last_event,
           substr(coalesce(last_body,''),1,80) AS last_body_80,
           substr(coalesce(address_text,''),1,60) AS address_60,
           zip_text,
           num_media,
           media_url0,
           distance_miles,
           last_seen_at
         FROM leads
         ORDER BY
           CASE WHEN LOWER(COALESCE(lead_source,'sms'))='manual' THEN 0 ELSE 1 END,
           last_seen_at DESC
         LIMIT 80`
      )
    ).rows;
    const esc = (s) => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
    const rowsHtml = rows.map(r => {
      const mediaHref = r.media_url0 ? ("/media-proxy?u=" + encodeURIComponent(r.media_url0)) : "";
      const mediaCell = mediaHref ? "<a target='_blank' href='" + mediaHref + "'>View</a>" : "";
      const source = String(r.lead_source || "sms").toLowerCase() === "manual"
        ? "<span style='display:inline-block;padding:2px 6px;border-radius:999px;background:#fde68a;color:#111;font-size:10px;font-weight:700;border:1px solid #f59e0b'>MANUAL</span>"
        : "<span style='display:inline-block;padding:2px 6px;border-radius:999px;background:#e2e8f0;color:#334155;font-size:10px;font-weight:700;border:1px solid #cbd5e1'>SMS</span>";
      const name = String(r.lead_name || "").trim();
      const quoted = Number.isFinite(Number(r.quoted_amount)) && Number(r.quoted_amount) > 0
        ? ("$" + (Number(r.quoted_amount) / 100).toLocaleString(undefined, { maximumFractionDigits: 0 }))
        : "—";
      return "<tr><td><a href='/admin/lead/" + esc(String(r.from_phone).replaceAll("+","%2B")) + "'>" + esc(r.from_phone) + "</a><div style='color:#475569;font-size:11px;margin-top:2px'>" + esc(name || "—") + "</div></td><td>" + source + "</td><td>" + esc(quoted) + "</td><td>" + esc(r.site_visit_date || "—") + "</td><td>" + esc(r.last_event) + "</td><td>" + esc(r.last_body_80) + "</td><td>" + esc(r.address_60) + "</td><td>" + esc(r.zip_text) + "</td><td>" + esc(r.num_media) + "</td><td>" + mediaCell + "</td><td>" + esc(r.distance_miles) + "</td><td>" + esc(r.last_seen_at) + "</td></tr>";
    }).join("");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>ICL Leads</title><style>body{font-family:system-ui;padding:16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;font-size:13px;vertical-align:top}th{background:#f6f6f6}</style></head><body><h2>ICL Intake Leads</h2><table><thead><tr><th>Lead</th><th>Source</th><th>Quoted</th><th>Visit</th><th>Last Event</th><th>Last Message</th><th>Address</th><th>ZIP</th><th>Media#</th><th>Media</th><th>Miles</th><th>Last Seen</th></tr></thead><tbody>" + rowsHtml + "</tbody></table></body></html>");
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/admin/leads/manual", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const fromPhone = normalizePhoneE164(body.from_phone || body.phone || "");
    if (!fromPhone) return res.status(400).json({ ok: false, error: "valid from_phone required" });
    const now = new Date().toISOString();
    const leadName = String(body.lead_name || "").trim() || null;
    const leadEmail = String(body.lead_email || "").trim() || null;
    const notes = String(body.notes || "").trim() || null;
    const addressText = String(body.address_text || body.address || "").trim() || null;
    const zipTextRaw = String(body.zip_text || body.zip || "").trim();
    const zipText = /^\d{5}$/.test(zipTextRaw) ? zipTextRaw : (extractZipFromLead({ address_text: addressText }) || null);
    const siteVisitDateRaw = String(body.site_visit_date || "").trim();
    const siteVisitDate = /^\d{4}-\d{2}-\d{2}$/.test(siteVisitDateRaw) ? siteVisitDateRaw : null;
    const leadSource = normalizeLeadSource(body.lead_source || "manual");
    const quotedCents = parseQuotedAmountToCents(body.quoted_amount);
    const convState = quotedCents ? "QUOTE_READY" : "NEW";
    const quoteStatus = quotedCents ? "AWAITING_DEPOSIT" : "NEW";

    const row = (
      await pool.query(
        `INSERT INTO leads (
           from_phone, to_phone, first_seen_at, last_seen_at,
           last_event, last_body, address_text, zip_text, zip,
           conv_state, quote_status, quote_total_cents, quoted_amount,
           lead_name, lead_email, notes, site_visit_date, lead_source, status,
           has_media, num_media
         )
         VALUES (
           $1, $2, $3, $3,
           'manual_lead_created', $4, $5, $6, $6,
           $7, $8, $9, $9,
           $10, $11, $12, $13, $14, 'ACTIVE',
           0, 0
         )
         ON CONFLICT (from_phone) DO UPDATE SET
           last_seen_at = EXCLUDED.last_seen_at,
           last_event = 'manual_lead_updated',
           last_body = COALESCE(EXCLUDED.last_body, leads.last_body),
           address_text = COALESCE(NULLIF(EXCLUDED.address_text,''), leads.address_text),
           zip_text = COALESCE(NULLIF(EXCLUDED.zip_text,''), leads.zip_text),
           zip = COALESCE(NULLIF(EXCLUDED.zip,''), leads.zip),
           conv_state = COALESCE(NULLIF(EXCLUDED.conv_state,''), leads.conv_state),
           quote_status = COALESCE(NULLIF(EXCLUDED.quote_status,''), leads.quote_status),
           quote_total_cents = COALESCE(EXCLUDED.quote_total_cents, leads.quote_total_cents),
           quoted_amount = COALESCE(EXCLUDED.quoted_amount, leads.quoted_amount),
           lead_name = COALESCE(NULLIF(EXCLUDED.lead_name,''), leads.lead_name),
           lead_email = COALESCE(NULLIF(EXCLUDED.lead_email,''), leads.lead_email),
           notes = COALESCE(NULLIF(EXCLUDED.notes,''), leads.notes),
           site_visit_date = COALESCE(NULLIF(EXCLUDED.site_visit_date,''), leads.site_visit_date),
           lead_source = COALESCE(NULLIF(EXCLUDED.lead_source,''), leads.lead_source),
           status = COALESCE(NULLIF(EXCLUDED.status,''), leads.status)
         RETURNING from_phone, lead_name, lead_email, notes, quoted_amount, site_visit_date, lead_source, quote_status, conv_state, quote_total_cents`,
        [
          fromPhone,
          process.env.TWILIO_PHONE_NUMBER || null,
          now,
          notes || "manual in-person consult",
          addressText,
          zipText,
          convState,
          quoteStatus,
          quotedCents,
          leadName,
          leadEmail,
          notes,
          siteVisitDate,
          leadSource
        ]
      )
    ).rows[0];

    insertEvent.run({
      from_phone: fromPhone,
      event_type: "manual_lead_upsert",
      payload_json: JSON.stringify({
        lead_name: leadName,
        lead_email: leadEmail,
        notes,
        quoted_amount_cents: quotedCents,
        site_visit_date: siteVisitDate,
        lead_source: leadSource,
        address_text: addressText,
        zip: zipText
      }),
      created_at: now
    });

    return res.json({ ok: true, lead: row, message: "Manual lead saved." });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/admin/leads/:from/payment-link", async (req, res) => {
  try {
    const fromPhone = normalizePhoneE164(req.params.from || "");
    if (!fromPhone) return res.status(400).json({ ok: false, error: "invalid lead phone" });
    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [fromPhone])).rows[0];
    if (!lead) return res.status(404).json({ ok: false, error: "lead not found" });

    const quoteFromBody = parseQuotedAmountToCents(req.body?.quoted_amount);
    const quoteFromLead = Number.isFinite(Number(lead.quote_total_cents)) && Number(lead.quote_total_cents) > 0
      ? Number(lead.quote_total_cents)
      : (Number.isFinite(Number(lead.quoted_amount)) && Number(lead.quoted_amount) > 0 ? Number(lead.quoted_amount) : null);
    const quoteCents = quoteFromBody || quoteFromLead;
    if (!quoteCents || quoteCents <= 0) {
      return res.status(400).json({ ok: false, error: "quoted_amount is required before generating payment link" });
    }

    const depositCents = Math.max(100, Number(process.env.SQUARE_DEPOSIT_CENTS || 5000));
    const upfrontDiscountPct = Number(process.env.UPFRONT_DISCOUNT_PCT || 10);
    const payment = await createSquarePaymentOptions(
      { from_phone: fromPhone },
      { quoteTotalCents: quoteCents, depositCents, upfrontDiscountPct }
    );
    const now = new Date().toISOString();

    await pool.query(
      `UPDATE leads
       SET square_payment_link_id=$1,
           square_payment_link_url=$2,
           square_order_id=$3,
           square_upfront_payment_link_id=$4,
           square_upfront_payment_link_url=$5,
           square_upfront_order_id=$6,
           quote_total_cents=$7,
           quoted_amount=COALESCE(quoted_amount,$7),
           upfront_total_cents=$8,
           upfront_discount_pct=$9,
           quote_status='AWAITING_DEPOSIT',
           conv_state=CASE WHEN conv_state IS NULL OR conv_state='' OR conv_state='NEW' THEN 'QUOTE_READY' ELSE conv_state END,
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
        fromPhone
      ]
    );

    insertEvent.run({
      from_phone: fromPhone,
      event_type: "square_quote_created",
      payload_json: JSON.stringify({
        from_phone: fromPhone,
        source: "admin_manual_generate",
        quote_total_cents: payment.quoteTotalCents,
        upfront_total_cents: payment.upfrontTotalCents,
        upfront_discount_pct: payment.upfrontDiscountPct,
        payment_link_url: payment.deposit.payment_link_url,
        upfront_payment_link_url: payment.upfront.payment_link_url
      }),
      created_at: now
    });

    return res.json({
      ok: true,
      from_phone: fromPhone,
      quote_total_cents: payment.quoteTotalCents,
      payment_link_url: payment.deposit.payment_link_url,
      upfront_payment_link_url: payment.upfront.payment_link_url
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

async function handleSimulateDeposit(req, res) {
  try {
    const rawFrom = String(req.params.from || "").trim();
    if (!rawFrom || rawFrom.startsWith(":")) {
      return res.status(400).json({
        ok: false,
        error: "invalid lead phone",
        hint: "Use a real phone in the path, e.g. /admin/leads/%2B13233979698/simulate-deposit"
      });
    }
    const fromPhone = normalizePhoneE164(req.params.from || "");
    if (!fromPhone) return res.status(400).json({ ok: false, error: "invalid lead phone" });
    const result = await simulateDepositForPhone(fromPhone, {
      baseUrl: String(process.env.APP_BASE_URL || process.env.BASE_URL || `https://${req.headers.host}`),
      forceSms: true
    });
    if (!result.ok) return res.status(404).json(result);
    return res.json({
      ok: true,
      booking_link: result.booking_link || null,
      confirmation_id: result.confirmation_id || null,
      actions_taken: result.actions_taken || [],
      actions_failed: result.actions_failed || []
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
app.post("/admin/leads/:from/simulate-deposit", handleSimulateDeposit);
app.get("/admin/leads/:from/simulate-deposit", handleSimulateDeposit);

app.post("/admin/leads/:from/load-bucket", async (req, res) => {
  try {
    const fromPhone = normalizePhoneE164(req.params.from || "");
    const bucket = String(req.body?.load_bucket || "").toUpperCase().trim();
    if (!fromPhone) return res.status(400).json({ ok: false, error: "invalid lead phone" });
    if (!["MIN", "QTR", "HALF", "3Q", "FULL"].includes(bucket)) {
      return res.status(400).json({ ok: false, error: "invalid load_bucket" });
    }
    await pool.query(
      `UPDATE leads
       SET load_bucket=$1,
           customer_load_bucket=$1,
           conv_state=CASE WHEN conv_state IS NULL OR conv_state='' OR conv_state='NEW' THEN 'QUOTE_READY' ELSE conv_state END,
           last_seen_at=NOW()
       WHERE from_phone=$2`,
      [bucket, fromPhone]
    );
    insertEvent.run({
      from_phone: fromPhone,
      event_type: "manual_load_bucket_override",
      payload_json: JSON.stringify({ load_bucket: bucket }),
      created_at: new Date().toISOString()
    });
    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [fromPhone])).rows[0] || null;
    return res.json({ ok: true, lead });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/admin/leads/:from/generate-quote", async (req, res) => {
  try {
    const fromPhone = normalizePhoneE164(req.params.from || "");
    if (!fromPhone) return res.status(400).json({ ok: false, error: "invalid lead phone" });
    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [fromPhone])).rows[0];
    if (!lead) return res.status(404).json({ ok: false, error: "lead not found" });
    if (!lead.load_bucket) return res.status(400).json({ ok: false, error: "lead load_bucket required before quote generation" });

    const pricing = priceQuoteV1({
      load_bucket: lead.load_bucket,
      distance_miles: Number(lead.distance_miles || 0),
      access_level: lead.access_level
    });
    const quotedCents = Number(pricing.total_cents || 0);
    if (!quotedCents) return res.status(500).json({ ok: false, error: "pricing failed" });

    const createPayment = String(req.body?.create_payment_link || "").toLowerCase() === "1" || req.body?.create_payment_link === true;
    let payment = null;
    if (createPayment) {
      const depositCents = Math.max(100, Number(process.env.SQUARE_DEPOSIT_CENTS || 5000));
      const upfrontDiscountPct = Number(process.env.UPFRONT_DISCOUNT_PCT || 10);
      payment = await createSquarePaymentOptions(
        { from_phone: fromPhone },
        { quoteTotalCents: quotedCents, depositCents, upfrontDiscountPct }
      );
    }

    if (payment) {
      await pool.query(
        `UPDATE leads
         SET quote_total_cents=$1,
             quoted_amount=$1,
             quote_status='AWAITING_DEPOSIT',
             conv_state=CASE WHEN conv_state IS NULL OR conv_state='' OR conv_state='NEW' THEN 'QUOTE_READY' ELSE conv_state END,
             square_payment_link_id=$2,
             square_payment_link_url=$3,
             square_order_id=$4,
             square_upfront_payment_link_id=$5,
             square_upfront_payment_link_url=$6,
             square_upfront_order_id=$7,
             upfront_total_cents=$8,
             upfront_discount_pct=$9,
             last_seen_at=NOW()
         WHERE from_phone=$10`,
        [
          quotedCents,
          payment.deposit.payment_link_id,
          payment.deposit.payment_link_url,
          payment.deposit.order_id,
          payment.upfront.payment_link_id,
          payment.upfront.payment_link_url,
          payment.upfront.order_id,
          payment.upfrontTotalCents,
          payment.upfrontDiscountPct,
          fromPhone
        ]
      );
    } else {
      await pool.query(
        `UPDATE leads
         SET quote_total_cents=$1,
             quoted_amount=$1,
             quote_status='QUOTE_READY',
             conv_state=CASE WHEN conv_state IS NULL OR conv_state='' OR conv_state='NEW' THEN 'QUOTE_READY' ELSE conv_state END,
             last_seen_at=NOW()
         WHERE from_phone=$2`,
        [quotedCents, fromPhone]
      );
    }

    insertEvent.run({
      from_phone: fromPhone,
      event_type: "pricing_v1",
      payload_json: JSON.stringify(pricing),
      created_at: new Date().toISOString()
    });
    if (payment) {
      insertEvent.run({
        from_phone: fromPhone,
        event_type: "square_quote_created",
        payload_json: JSON.stringify({
          from_phone: fromPhone,
          source: "manual_generate_quote",
          quote_total_cents: payment.quoteTotalCents,
          upfront_total_cents: payment.upfrontTotalCents,
          upfront_discount_pct: payment.upfrontDiscountPct,
          payment_link_url: payment.deposit.payment_link_url,
          upfront_payment_link_url: payment.upfront.payment_link_url
        }),
        created_at: new Date().toISOString()
      });
    }

    const updated = (await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [fromPhone])).rows[0] || null;
    return res.json({
      ok: true,
      quote_total_cents: quotedCents,
      quote_total_dollars: Math.round((quotedCents / 100) * 100) / 100,
      payment_link_url: payment?.deposit?.payment_link_url || null,
      upfront_payment_link_url: payment?.upfront?.payment_link_url || null,
      updated_lead: updated
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/admin/leads/:from/photos", upload.array("photos", MANUAL_MEDIA_MAX_FILES), async (req, res) => {
  try {
    const fromPhone = normalizePhoneE164(req.params.from || "");
    if (!fromPhone) return res.status(400).json({ ok: false, error: "invalid lead phone" });
    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [fromPhone])).rows[0];
    if (!lead) return res.status(404).json({ ok: false, error: "lead not found" });
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ ok: false, error: "no photos uploaded" });

    const prepared = await prepareLeadMediaStorage(files, fromPhone);
    if (!prepared.ok || !prepared.storedMedia.length || !prepared.analysisInputs.length) {
      return res.status(400).json({ ok: false, error: "no valid photos processed", skipped: prepared.warnings || [] });
    }

    const existingStored = parseJsonArrayText(lead.media_urls);
    const mergedStored = [...existingStored, ...prepared.storedMedia].slice(-MANUAL_MEDIA_MAX_FILES);
    const firstStored = String(mergedStored[0] || "");
    const mediaUrl0 = /^data:image\//i.test(firstStored) ? null : (firstStored || lead.media_url0 || null);

    await pool.query(
      `UPDATE leads
       SET media_urls=$1,
           has_media=1,
           num_media=$2,
           media_url0=COALESCE($3, media_url0),
           last_seen_at=NOW()
       WHERE from_phone=$4`,
      [JSON.stringify(mergedStored), mergedStored.length, mediaUrl0, fromPhone]
    );

    const { vision, updatedLead } = await runManualVisionAndPersist(fromPhone, mergedStored);
    const itemList = extractVisionItemList(vision);
    insertEvent.run({
      from_phone: fromPhone,
      event_type: "manual_photo_upload_analyzed",
      payload_json: JSON.stringify({
        storage_mode: prepared.storageMode,
        uploaded_count: prepared.storedMedia.length,
        total_media_count: mergedStored.length,
        load_bucket: vision.load_bucket || null,
        load_confidence: vision.load_confidence || null
      }),
      created_at: new Date().toISOString()
    });

    return res.json({
      ok: true,
      skipped: prepared.warnings || [],
      storage_mode: prepared.storageMode,
      vision_result: {
        load_bucket: vision.load_bucket || null,
        load_confidence: vision.load_confidence || null,
        item_list: itemList,
        items: Array.isArray(vision.items) ? vision.items : []
      },
      updated_lead: updatedLead
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/admin/leads/:from/reanalyze", async (req, res) => {
  try {
    const fromPhone = normalizePhoneE164(req.params.from || "");
    if (!fromPhone) return res.status(400).json({ ok: false, error: "invalid lead phone" });
    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [fromPhone])).rows[0];
    if (!lead) return res.status(404).json({ ok: false, error: "lead not found" });
    const media = parseJsonArrayText(lead.media_urls);
    if (!media.length) return res.status(400).json({ ok: false, error: "no stored media to analyze" });
    const { vision, updatedLead } = await runManualVisionAndPersist(fromPhone, media);
    const itemList = extractVisionItemList(vision);
    insertEvent.run({
      from_phone: fromPhone,
      event_type: "manual_photo_reanalyzed",
      payload_json: JSON.stringify({
        total_media_count: media.length,
        load_bucket: vision.load_bucket || null,
        load_confidence: vision.load_confidence || null
      }),
      created_at: new Date().toISOString()
    });
    return res.json({
      ok: true,
      vision_result: {
        load_bucket: vision.load_bucket || null,
        load_confidence: vision.load_confidence || null,
        item_list: itemList,
        items: Array.isArray(vision.items) ? vision.items : []
      },
      updated_lead: updatedLead
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
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
    const mediaUrls = renderableLeadMediaUrls(from, parseJsonArrayText(lead?.media_urls), 24);
    for (const e of events) {
      try {
        const pj = JSON.parse(e.payload_json || "{}");
        const u = pj.MediaUrl0 || pj.mediaUrl0 || null;
        if (u && !mediaUrls.includes(u)) mediaUrls.push(u);
      } catch {}
    }
    const esc = (s) => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
    const evHtml = events.map(e => "<tr><td>" + esc(e.created_at) + "</td><td>" + esc(e.event_type) + "</td><td><pre style='white-space:pre-wrap;margin:0'>" + esc(e.payload_json) + "</pre></td></tr>").join("");
    const mediaHtml = !mediaUrls.length ? "<p>No media.</p>" : mediaUrls.map((u,i) => {
      const direct = /^https?:\/\//i.test(u) ? ("/media-proxy?u=" + encodeURIComponent(u)) : u;
      return "<div style='margin:10px 0'><a href='" + direct + "' target='_blank'>Open media " + (i+1) + "</a><br/><img src='" + direct + "' style='max-width:360px;border:1px solid #ddd;border-radius:10px;margin-top:6px'/></div>";
    }).join("");
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
