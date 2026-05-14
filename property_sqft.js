const fetchFn = typeof fetch === "function"
  ? fetch.bind(globalThis)
  : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const LOAD_BUCKET_SQFT_FALLBACK = {
  MIN: 700,
  QTR: 1000,
  HALF: 1500,
  "3Q": 2100,
  FULL: 2800,
};

function asInt(raw) {
  const n = Math.round(Number(raw || 0));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeLoadBucket(raw) {
  const v = String(raw || "").toUpperCase().trim();
  if (v === "SMALL") return "MIN";
  if (v === "MEDIUM") return "HALF";
  if (v === "LARGE") return "FULL";
  if (v === "MIN" || v === "QTR" || v === "HALF" || v === "3Q" || v === "FULL") return v;
  return "";
}

function estimateSqftFromLoadBucket(load_bucket) {
  const b = normalizeLoadBucket(load_bucket);
  return LOAD_BUCKET_SQFT_FALLBACK[b] || null;
}

function normalizeAddress(address, zip) {
  const base = String(address || "").replace(/\s+/g, " ").trim();
  const zipText = String(zip || "").trim();
  if (!base) return "";
  if (!zipText) return base;
  if (new RegExp(`\\b${zipText}\\b`).test(base)) return base;
  return `${base}, ${zipText}`;
}

function extractSqft(record) {
  if (!record || typeof record !== "object") return null;
  const direct = [
    record.squareFootage,
    record.square_feet,
    record.square_feet_living,
    record.livingArea,
    record.livingAreaSqFt,
    record.buildingSquareFeet,
    record.buildingAreaSqFt,
  ];
  for (const candidate of direct) {
    const n = asInt(candidate);
    if (n && n >= 200 && n <= 15000) return n;
  }
  const nested = [
    record.features && record.features.livingArea,
    record.features && record.features.squareFootage,
    record.features && record.features.buildingAreaSqFt,
    record.structure && record.structure.livingArea,
    record.structure && record.structure.squareFootage,
  ];
  for (const candidate of nested) {
    const n = asInt(candidate);
    if (n && n >= 200 && n <= 15000) return n;
  }
  return null;
}

function failureResult(reason, load_bucket, extra) {
  return {
    ok: false,
    sqft: null,
    source: "fallback",
    reason: String(reason || "lookup_failed"),
    fallback_sqft: estimateSqftFromLoadBucket(load_bucket),
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

async function lookupSqftByAddress({ address, zip, load_bucket, timeout_ms = 8000 } = {}) {
  const normalizedAddress = normalizeAddress(address, zip);
  if (!normalizedAddress) {
    return failureResult("missing_address", load_bucket);
  }

  const rentcastKey = String(process.env.RENTCAST_API_KEY || "").trim();
  if (!rentcastKey) {
    return failureResult("provider_not_configured", load_bucket, { normalized_address: normalizedAddress });
  }

  const url = `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(normalizedAddress)}&limit=1`;
  const timeoutMs = Math.max(1000, Number(timeout_ms || 8000));
  const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutHandle = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        "X-Api-Key": rentcastKey,
        "Accept": "application/json",
      },
      ...(ac ? { signal: ac.signal } : {}),
    });
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (!res.ok) {
      return failureResult(`rentcast_http_${res.status}`, load_bucket, { normalized_address: normalizedAddress });
    }
    const rows = await res.json();
    const first = Array.isArray(rows) ? rows[0] : null;
    if (!first) {
      return failureResult("rentcast_not_found", load_bucket, { normalized_address: normalizedAddress });
    }
    const sqft = extractSqft(first);
    if (!sqft) {
      return failureResult("rentcast_sqft_missing", load_bucket, {
        normalized_address: normalizedAddress,
        matched_address: first.formattedAddress || null,
      });
    }
    return {
      ok: true,
      sqft,
      source: "rentcast",
      matched_address: first.formattedAddress || null,
    };
  } catch (e) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    return failureResult("rentcast_request_failed", load_bucket, {
      normalized_address: normalizedAddress,
      error: String((e && e.message) || e),
    });
  }
}

module.exports = {
  lookupSqftByAddress,
  estimateSqftFromLoadBucket,
};
