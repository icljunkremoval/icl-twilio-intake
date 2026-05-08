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

const CLEAROUT_BASE_CENTS = 35000; // $350 baseline mobilization for clearouts
const CLEAROUT_RATE_PER_SQFT_CENTS = 85; // $0.85 per sqft
const CLEAROUT_MIN_CENTS = 65000; // guardrail floor: $650
const CLEAROUT_MAX_CENTS = 399700; // guardrail ceiling: $3,997
const CLEAROUT_LOAD_MULTIPLIER = {
  MIN: 0.72,
  QTR: 0.84,
  HALF: 0.96,
  "3Q": 1.08,
  FULL: 1.20,
};

function normalizedLoadBucket(raw) {
  const bucket = String(raw || "").toUpperCase().trim();
  if (bucket === "SMALL") return "MIN";
  if (bucket === "MEDIUM") return "HALF";
  if (bucket === "LARGE") return "FULL";
  if (bucket === "MIN" || bucket === "QTR" || bucket === "HALF" || bucket === "3Q" || bucket === "FULL") return bucket;
  return "HALF";
}

function asSqft(raw) {
  const n = Math.round(Number(raw || 0));
  if (!Number.isFinite(n) || n < 200 || n > 15000) return null;
  return n;
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

function shouldUseSqftClearout({ vision, load_bucket, has_media, num_media } = {}) {
  const v = vision && typeof vision === "object" ? vision : {};
  const bucket = normalizedLoadBucket(load_bucket || v.load_bucket);
  const items = Array.isArray(v.items) ? v.items : [];
  const tags = (Array.isArray(v.data_tags) ? v.data_tags : []).map((x) => String(x || "").toLowerCase().trim());
  const notes = String(v.crew_notes || "");
  const photoCount = Math.max(0, Math.round(Number(v.photo_count || num_media || 0)));
  const hasMedia = Boolean(has_media) || photoCount > 0 || items.length > 0;
  const reasons = [];

  if (bucket === "3Q" || bucket === "FULL") reasons.push("high_load_bucket");
  if (items.length >= 10) reasons.push("many_items_visible");
  if (photoCount >= 5 && (bucket === "HALF" || bucket === "3Q" || bucket === "FULL")) reasons.push("multi_photo_scope");
  if (tags.includes("mixed") || tags.includes("boxes")) reasons.push("mixed_household_tags");
  if (/(whole|entire|packed|multiple rooms?|estate|move[-\s]?out|clearout|clutter)/i.test(notes)) {
    reasons.push("crew_notes_scope");
  }

  return {
    use: hasMedia && (reasons.includes("high_load_bucket") || reasons.length >= 2),
    reasons,
    bucket,
    photo_count: photoCount,
    items_count: items.length,
  };
}

function priceClearoutBySqftV1({
  property_sqft,
  load_bucket,
  distance_miles,
  access_level,
  photo_count,
}) {
  const sqft = asSqft(property_sqft);
  if (!sqft) throw new Error("Invalid property_sqft for clearout pricing");

  const bucket = normalizedLoadBucket(load_bucket);
  const loadMultiplier = CLEAROUT_LOAD_MULTIPLIER[bucket] || 1;
  const photoCount = Math.max(0, Math.round(Number(photo_count || 0)));
  const photoMultiplier = photoCount >= 8 ? 1.08 : photoCount >= 5 ? 1.05 : 1;

  const baseRaw = (CLEAROUT_BASE_CENTS + sqft * CLEAROUT_RATE_PER_SQFT_CENTS) * loadMultiplier * photoMultiplier;
  const base = Math.max(CLEAROUT_MIN_CENTS, Math.min(CLEAROUT_MAX_CENTS, Math.round(baseRaw)));

  const miles = Number(distance_miles || 0);
  const over = Math.max(0, miles - INCLUDED_RADIUS_MILES);
  const distanceAdder = Math.round(over * DISTANCE_RATE_CENTS_PER_MILE_ONE_WAY);

  const access = String(access_level || "").toUpperCase();
  const accessAdder = ACCESS_UPLIFT_LEVELS.has(access) ? ACCESS_UPLIFT_CENTS : 0;

  return {
    strategy: "SQFT_CLEAROUT",
    bucket,
    property_sqft: sqft,
    clearout_base_cents: base,
    base_cents: base,
    distance_miles: miles,
    distance_adder_cents: distanceAdder,
    access_level: access,
    access_adder_cents: accessAdder,
    photo_count: photoCount,
    total_cents: base + distanceAdder + accessAdder,
  };
}

module.exports = {
  BASE_BY_BUCKET_CENTS,
  INCLUDED_RADIUS_MILES,
  DISTANCE_RATE_CENTS_PER_MILE_ONE_WAY,
  ACCESS_UPLIFT_CENTS,
  ACCESS_UPLIFT_LEVELS,
  CLEAROUT_BASE_CENTS,
  CLEAROUT_RATE_PER_SQFT_CENTS,
  CLEAROUT_MIN_CENTS,
  CLEAROUT_MAX_CENTS,
  CLEAROUT_LOAD_MULTIPLIER,
  shouldUseSqftClearout,
  priceClearoutBySqftV1,
  priceQuoteV1,
};
