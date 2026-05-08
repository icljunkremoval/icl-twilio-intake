const fetch = require("node-fetch");

function asInt(raw) {
  const n = Math.round(Number(raw || 0));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeAddress(address, zip) {
  const base = String(address || "").replace(/\s+/g, " ").trim();
  const zipText = String(zip || "").trim();
  if (!base) return "";
  let out = base;
  if (zipText && !new RegExp(`\\b${zipText}\\b`).test(out)) out = `${out}, ${zipText}`;
  if (!/,\s*CA\b/i.test(out)) out = `${out}, CA`;
  return out;
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

async function lookupSqftByAddress({ address, zip, timeout_ms = 8000 } = {}) {
  const normalizedAddress = normalizeAddress(address, zip);
  if (!normalizedAddress) {
    return { ok: false, sqft: null, source: "none", reason: "missing_address" };
  }

  const rentcastKey = String(process.env.RENTCAST_API_KEY || "").trim();
  if (!rentcastKey) {
    return { ok: false, sqft: null, source: "none", reason: "provider_not_configured", normalized_address: normalizedAddress };
  }

  const url = `https://api.rentcast.io/v1/properties?address=${encodeURIComponent(normalizedAddress)}&limit=1`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-Api-Key": rentcastKey,
        "Accept": "application/json",
      },
      timeout: Math.max(1000, Number(timeout_ms || 8000)),
    });
    if (!res.ok) {
      return {
        ok: false,
        sqft: null,
        source: "rentcast",
        reason: `http_${res.status}`,
        normalized_address: normalizedAddress,
      };
    }
    const rows = await res.json();
    const first = Array.isArray(rows) ? rows[0] : null;
    if (!first) {
      return { ok: false, sqft: null, source: "rentcast", reason: "not_found", normalized_address: normalizedAddress };
    }
    const sqft = extractSqft(first);
    if (!sqft) {
      return {
        ok: false,
        sqft: null,
        source: "rentcast",
        reason: "sqft_missing",
        normalized_address: normalizedAddress,
        matched_address: first.formattedAddress || null,
      };
    }
    return {
      ok: true,
      sqft,
      source: "rentcast",
      reason: "ok",
      normalized_address: normalizedAddress,
      matched_address: first.formattedAddress || null,
    };
  } catch (e) {
    return {
      ok: false,
      sqft: null,
      source: "rentcast",
      reason: "request_failed",
      error: String((e && e.message) || e),
      normalized_address: normalizedAddress,
    };
  }
}

module.exports = {
  lookupSqftByAddress,
};
