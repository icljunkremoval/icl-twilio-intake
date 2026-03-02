// PRICING & ADDERS v1 — ICL Junk Removal

const BASE_BY_BUCKET_CENTS = {
  MIN: 15000,
  QTR: 45000,
  HALF: 85000,
  "3Q": 120000,
  FULL: 150000,
};

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
  priceQuoteV1,
};
