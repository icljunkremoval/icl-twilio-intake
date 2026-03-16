const crypto = require("crypto");

function secretKey() {
  return String(
    process.env.BOOKING_LINK_SECRET ||
    process.env.ADMIN_PASSWORD ||
    "icl-booking-dev-secret"
  );
}

function signPayload(payload) {
  return crypto
    .createHmac("sha256", secretKey())
    .update(String(payload))
    .digest("base64url");
}

function normalizePhone(phone) {
  return String(phone || "").trim();
}

function createBookingToken(phone) {
  const p = normalizePhone(phone);
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `${p}|${issuedAt}`;
  const sig = signPayload(payload).slice(0, 24);
  return Buffer.from(`${payload}|${sig}`, "utf8").toString("base64url");
}

function parseBookingToken(token, { maxAgeDays = 30 } = {}) {
  try {
    const raw = Buffer.from(String(token || ""), "base64url").toString("utf8");
    const [phone, tsRaw, sig] = raw.split("|");
    if (!phone || !tsRaw || !sig) return { ok: false, error: "malformed" };
    const issuedAt = Number(tsRaw);
    if (!Number.isFinite(issuedAt)) return { ok: false, error: "bad_ts" };
    const ageSec = Math.floor(Date.now() / 1000) - issuedAt;
    if (ageSec < 0 || ageSec > Number(maxAgeDays) * 86400) return { ok: false, error: "expired" };
    const expected = signPayload(`${phone}|${issuedAt}`).slice(0, 24);
    if (sig !== expected) return { ok: false, error: "invalid_sig" };
    return { ok: true, phone, issuedAt };
  } catch (e) {
    return { ok: false, error: "parse_failed" };
  }
}

function buildBookingLink(baseUrl, phone) {
  const cleanBase = String(baseUrl || "").replace(/\/+$/, "");
  const token = createBookingToken(phone);
  return `${cleanBase}/booking/${token}`;
}

module.exports = { createBookingToken, parseBookingToken, buildBookingLink };
