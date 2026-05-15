// PRICING & ADDERS v1 — ICL Junk Removal

const BASE_BY_BUCKET_CENTS = {
  MIN:  14700,   // $147  — entry point, below market friction
  QTR:  32300,   // $323  — at market average, high conversion
  HALF: 62300,   // $623  — under $650 psychological ceiling
  "3Q": 104700,  // $1,047 — premium but justifiable
  FULL: 124700,  // $1,247 — competitive with high end of market
};

// SALVAGE TARGETS (20-30% of service revenue recovered through resell)
// MIN:  $29  target salvage
// QTR:  $65  target salvage
// HALF: $125 target salvage
// 3Q:   $209 target salvage
// FULL: $249 target salvage

const INCLUDED_RADIUS_MILES = 10;
const DISTANCE_RATE_CENTS_PER_MILE_ONE_WAY = 300; // $3/mi one-way after included radius
const ACCESS_UPLIFT_CENTS = 5000; // $50 internal only (not itemized)

const ACCESS_UPLIFT_LEVELS = new Set([
  "STAIRS",
  "ELEVATOR",
  "COMPLEX",
  "LONG_CARRY",
  "TIGHT_PARKING",
  "GATED_FRICTION",
]);

const ADDON_PRICING = {
  DEEP_CLEAN: 15000,
  PRESSURE_WASH: 12500,
  PAINT_TOUCHUP: 17500,
  MINOR_REPAIRS: null,
};

function getAddonSqft(lead) {
  const explicitSqft = Math.round(Number(lead?.rentcast_sqft || 0));
  if (Number.isFinite(explicitSqft) && explicitSqft > 0) return explicitSqft;
  const bucket = String(lead?.load_bucket || "").toUpperCase();
  const SQFT_PROXY = { MIN: 700, QTR: 1000, HALF: 1500, "3Q": 2100, FULL: 2800 };
  return SQFT_PROXY[bucket] || 1500;
}

function calcDeepClean(sqft) {
  const n = Math.max(0, Number(sqft || 0));
  return Math.max(150, Math.round((n * 0.08) / 5) * 5);
}

function calcPressureWash(sqft) {
  const n = Math.max(0, Number(sqft || 0));
  return Math.max(125, Math.round((n * 0.4 * 0.06) / 5) * 5);
}

function calcPaintTouchup(sqft) {
  const n = Math.max(0, Number(sqft || 0));
  if (n <= 2000) return 175;
  if (n <= 4000) return 275;
  return 375;
}

function normalizeAddonCode(addon) {
  if (typeof addon === "string") return addon.toUpperCase().trim();
  return String(addon?.code || "").toUpperCase().trim();
}

function prettyAddonName(code) {
  const normalized = String(code || "").toUpperCase().trim();
  const map = {
    DEEP_CLEAN: "Deep Clean",
    PRESSURE_WASH: "Pressure Wash",
    PAINT_TOUCHUP: "Paint Touch-Ups",
    PAINT_TOUCHUPS: "Paint Touch-Ups",
  };
  return map[normalized] || normalized;
}

function formatAddonList(selectedAddons) {
  if (!Array.isArray(selectedAddons) || !selectedAddons.length) return "";
  const names = selectedAddons
    .map((addon) => prettyAddonName(normalizeAddonCode(addon)))
    .filter(Boolean);
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} included`;
  if (names.length === 2) return `${names[0]} and ${names[1]} included`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]} included`;
}

function computeAddonTotalCents(selectedAddons, sqft) {
  const safeSqft = Math.max(1, Math.round(Number(sqft || 0))) || 1500;
  const list = Array.isArray(selectedAddons) ? selectedAddons : [];
  let total = 0;
  for (const addon of list) {
    const code = normalizeAddonCode(addon);
    if (code === "DEEP_CLEAN") total += calcDeepClean(safeSqft) * 100;
    else if (code === "PRESSURE_WASH") total += calcPressureWash(safeSqft) * 100;
    else if (code === "PAINT_TOUCHUP" || code === "PAINT_TOUCHUPS") total += calcPaintTouchup(safeSqft) * 100;
  }
  return total;
}

function priceQuoteV1({ load_bucket, distance_miles, access_level }) {
  const bucket = String(load_bucket || "").toUpperCase();
  if (!BASE_BY_BUCKET_CENTS[bucket]) throw new Error(`Unknown load_bucket: ${bucket}`);

  const base = BASE_BY_BUCKET_CENTS[bucket];

  const miles = Number(distance_miles || 0);
  const over = Math.max(0, miles - INCLUDED_RADIUS_MILES);
  const distanceAdder = Math.round(over * DISTANCE_RATE_CENTS_PER_MILE_ONE_WAY);

  const access = String(access_level || "").toUpperCase();
  const accessAdder = ACCESS_UPLIFT_LEVELS.has(access) ? ACCESS_UPLIFT_CENTS : 0;

  const total = base + distanceAdder + accessAdder;

  return {
    bucket,
    base_cents: base,
    distance_miles: miles,
    distance_adder_cents: distanceAdder,
    access_level: access,
    access_adder_cents: accessAdder,
    total_cents: total,
  };
}

module.exports = {
  BASE_BY_BUCKET_CENTS,
  INCLUDED_RADIUS_MILES,
  DISTANCE_RATE_CENTS_PER_MILE_ONE_WAY,
  ACCESS_UPLIFT_CENTS,
  ACCESS_UPLIFT_LEVELS,
  ADDON_PRICING,
  getAddonSqft,
  calcDeepClean,
  calcPressureWash,
  calcPaintTouchup,
  computeAddonTotalCents,
  prettyAddonName,
  formatAddonList,
  priceQuoteV1,
};
