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
  priceQuoteV1,
};
