function asObj(v) {
  return v && typeof v === "object" ? v : {};
}

function cleanList(arr, limit = 40) {
  const out = [];
  const seen = new Set();
  const src = Array.isArray(arr) ? arr : [];
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

function normalizeBucketName(v) {
  const s = String(v || "").trim().toUpperCase();
  if (s === "RESELL" || s === "RESALE") return "RESELL";
  if (s === "SCRAP") return "SCRAP";
  if (s === "DONATE" || s === "DONATION") return "DONATE";
  if (s === "DUMP" || s === "TRASH" || s === "LANDFILL") return "DUMP";
  return null;
}

const SCRAP_RE = /\b(copper|wire|wiring|aluminum|steel|metal|rebar|pipe|cast\s*iron|brass|radiator|appliance\s*shell|scrap)\b/i;
const DONATE_RE = /\b(clothes?|clothing|books?|toys?|baby|stroller|crib|linen|blanket|kitchenware|utensil|dish|plate|cup|mug|small\s*appliance|donat(e|ion)|good\s*condition)\b/i;
const RESELL_RE = /\b(sofa|couch|dresser|table|desk|chair|cabinet|shelf|bookshelf|bike|bicycle|barbell|dumbbell|plates?|rack|tool|toolbox|lawnmower|generator|washer|dryer|fridge|refrigerator|microwave|ac\s*unit|tv|monitor|speaker|computer|laptop|iphone|electronics?)\b/i;

function classifyByKeyword(item) {
  const s = String(item || "");
  if (!s) return "DUMP";
  if (SCRAP_RE.test(s)) return "SCRAP";
  if (RESELL_RE.test(s)) return "RESELL";
  if (DONATE_RE.test(s)) return "DONATE";
  return "DUMP";
}

function extractVisionBuckets(visionInput, opts = {}) {
  const vision = asObj(visionInput);
  const limitPerBucket = Number(opts.limitPerBucket) > 0 ? Number(opts.limitPerBucket) : 12;

  const byBucket = { RESELL: [], SCRAP: [], DONATE: [], DUMP: [] };
  const seen = new Set();

  const add = (bucketName, rawItem) => {
    const bucket = normalizeBucketName(bucketName);
    if (!bucket) return;
    if (!byBucket[bucket] || byBucket[bucket].length >= limitPerBucket) return;
    const item = String(rawItem || "").trim();
    if (!item) return;
    const key = item.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    byBucket[bucket].push(item);
  };

  const classified = Array.isArray(vision.classified_items) ? vision.classified_items : [];
  for (const row of classified) {
    const item = String(row?.item || "").trim();
    if (!item) continue;
    add(row?.bucket, item);
  }

  for (const item of cleanList(vision.resell_items, limitPerBucket * 2)) add("RESELL", item);
  for (const item of cleanList(vision.scrap_items, limitPerBucket * 2)) add("SCRAP", item);
  for (const item of cleanList(vision.donate_items, limitPerBucket * 2)) add("DONATE", item);
  for (const item of cleanList(vision.dump_items, limitPerBucket * 2)) add("DUMP", item);

  for (const item of cleanList(vision.items, limitPerBucket * 6)) {
    if (seen.has(item.toLowerCase())) continue;
    add(classifyByKeyword(item), item);
  }

  const allItems = cleanList(
    [
      ...byBucket.RESELL,
      ...byBucket.SCRAP,
      ...byBucket.DONATE,
      ...byBucket.DUMP,
      ...cleanList(vision.items, limitPerBucket * 6)
    ],
    limitPerBucket * 8
  );

  return {
    resell_items: byBucket.RESELL,
    scrap_items: byBucket.SCRAP,
    donate_items: byBucket.DONATE,
    dump_items: byBucket.DUMP,
    items: allItems
  };
}

function normalizeVisionPayload(raw) {
  const src = asObj(raw);
  const buckets = extractVisionBuckets(src, { limitPerBucket: 16 });
  const loadConf = String(src.load_confidence || "").toUpperCase();
  const baseConfidence = loadConf === "HIGH" ? 0.85 : loadConf === "MEDIUM" ? 0.68 : loadConf === "LOW" ? 0.5 : 0.58;

  const safeConfidence = {};
  const maybe = asObj(src.bucket_confidence || {});
  const keys = [
    ["resell", buckets.resell_items.length],
    ["scrap", buckets.scrap_items.length],
    ["donate", buckets.donate_items.length],
    ["dump", buckets.dump_items.length]
  ];
  for (const [k, count] of keys) {
    const rawScore = Number(maybe[k]);
    if (Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 1) {
      safeConfidence[k] = rawScore;
    } else if (count > 0) {
      safeConfidence[k] = baseConfidence;
    } else {
      safeConfidence[k] = 0;
    }
  }

  const classifiedItems = [];
  const pushClassified = (bucket, arr) => {
    const score = Number(safeConfidence[bucket.toLowerCase()]) || baseConfidence;
    for (const item of arr) classifiedItems.push({ item, bucket, confidence: score });
  };
  pushClassified("RESELL", buckets.resell_items);
  pushClassified("SCRAP", buckets.scrap_items);
  pushClassified("DONATE", buckets.donate_items);
  pushClassified("DUMP", buckets.dump_items);

  return {
    ...src,
    items: buckets.items,
    resell_items: buckets.resell_items,
    scrap_items: buckets.scrap_items,
    donate_items: buckets.donate_items,
    dump_items: buckets.dump_items,
    classified_items: classifiedItems.slice(0, 40),
    bucket_confidence: safeConfidence
  };
}

module.exports = {
  extractVisionBuckets,
  normalizeVisionPayload
};
