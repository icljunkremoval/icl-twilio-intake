const { google } = require('googleapis');

let warnedMissingCalendarConfig = false;
// Default calendar requested for scheduled jobs visibility.
const DEFAULT_GROUP_CALENDAR_ID =
  "c_55b6a7c060862d8a44bb038ae4d0b7f1553c35e69ccd37fe2960aebcf661a891@group.calendar.google.com";
const LA_TZ = 'America/Los_Angeles';
const WINDOW_SLOTS = [
  { label: "8-10am", start: 8, end: 10 },
  { label: "10-12pm", start: 10, end: 12 },
  { label: "12-2pm", start: 12, end: 14 },
  { label: "2-4pm", start: 14, end: 16 },
  { label: "4-6pm", start: 16, end: 18 },
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseIsoDateParts(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function isoDateFromLabel(dateStr) {
  const raw = String(dateStr || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };
  const parts = raw.split(/\s+/);
  let mon = "";
  let day = NaN;
  if (parts.length >= 3) {
    mon = String(parts[1] || "").slice(0, 3).toLowerCase();
    day = parseInt(parts[2], 10);
  } else if (parts.length >= 2) {
    mon = String(parts[0] || "").slice(0, 3).toLowerCase();
    day = parseInt(parts[1], 10);
  }
  const month = MONTHS[mon];
  if (!month || !Number.isFinite(day)) return null;
  const now = new Date();
  let year = now.getFullYear();
  const noonCandidateTs = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  if (Number.isFinite(noonCandidateTs) && noonCandidateTs < (now.getTime() - 12 * 3600 * 1000)) year += 1;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function tzOffsetMinutesForIsoDate(isoDate) {
  const noonUtc = new Date(`${isoDate}T12:00:00.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    timeZoneName: "shortOffset"
  }).formatToParts(noonUtc);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "GMT-8";
  const m = String(tzPart).match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return -480;
  const sign = m[1] === "-" ? -1 : 1;
  const hh = Number(m[2] || 0);
  const mm = Number(m[3] || 0);
  return sign * (hh * 60 + mm);
}

function utcRangeForLaDay(isoDate) {
  const p = parseIsoDateParts(isoDate);
  if (!p) return null;
  const offsetMin = tzOffsetMinutesForIsoDate(isoDate);
  const startUtcMs = Date.UTC(p.y, p.m - 1, p.d, 0, 0, 0, 0) - (offsetMin * 60 * 1000);
  const endUtcMs = startUtcMs + (24 * 3600 * 1000) - 1;
  return {
    timeMin: new Date(startUtcMs).toISOString(),
    timeMax: new Date(endUtcMs).toISOString()
  };
}

function laDateAndHour(dateObj) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  }).formatToParts(dateObj);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return {
    iso: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour") || 0)
  };
}

function parseCalendarIdFromUrl(urlRaw) {
  try {
    const u = new URL(String(urlRaw || "").trim());
    const cid = String(u.searchParams.get("cid") || "").trim();
    if (!cid) return null;
    // cid may already be a full calendar id or a base64url-encoded id.
    if (cid.includes("@")) return cid;
    const padded = cid + "=".repeat((4 - (cid.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64url").toString("utf8").trim();
    return decoded.includes("@") ? decoded : null;
  } catch {
    return null;
  }
}

function resolveCalendarId() {
  return (
    String(process.env.GOOGLE_CALENDAR_ID || "").trim() ||
    parseCalendarIdFromUrl(process.env.GOOGLE_CALENDAR_URL) ||
    DEFAULT_GROUP_CALENDAR_ID
  );
}

function hasCalendarConfig() {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN &&
    resolveCalendarId()
  );
}

function getCalendarClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

function parseTimingPref(timing_pref) {
  const match = String(timing_pref || "").match(/(\w+ \w+ \d+),\s*(\d+)(am|pm)?-(\d+)(am|pm)/i);
  if (!match) return null;
  const [, dateStr, startHour, startAmPmRaw, endHour, endAmPmRaw] = match;
  const endAmPm = String(endAmPmRaw || "").toLowerCase();
  let startAmPm = String(startAmPmRaw || "").toLowerCase();
  if (!startAmPm) {
    const sh = parseInt(startHour, 10);
    const eh = parseInt(endHour, 10);
    if (endAmPm === "am") {
      startAmPm = "am";
    } else {
      // Handles 10-12pm -> 10am start, while keeping 12-2pm / 2-4pm as PM starts.
      startAmPm = (sh === 12 || eh !== 12) ? "pm" : "am";
    }
  }
  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
  };
  const parts = String(dateStr).trim().split(/\s+/);
  const monRaw = String(parts[1] || "").slice(0, 3).toLowerCase();
  const month = MONTHS[monRaw];
  const day = parseInt(parts[2], 10);
  if (!month || !Number.isFinite(day)) return null;

  const now = new Date();
  let year = now.getFullYear();
  const noonCandidateTs = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  // If date label is already behind us (year rollover edge), use next year.
  if (Number.isFinite(noonCandidateTs) && noonCandidateTs < (now.getTime() - 12 * 3600 * 1000)) {
    year += 1;
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  function toHour24(h, ampm) {
    let hour = parseInt(h);
    if (ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
    return hour;
  }
  const startHour24 = toHour24(startHour, startAmPm);
  const endHour24 = toHour24(endHour, endAmPm);
  // Use local wall-clock times for America/Los_Angeles (no trailing Z).
  const startLocal = `${year}-${pad2(month)}-${pad2(day)}T${pad2(startHour24)}:00:00`;
  const endLocal = `${year}-${pad2(month)}-${pad2(day)}T${pad2(endHour24)}:00:00`;
  return { startLocal, endLocal };
}

async function createJobEvent(lead) {
  try {
    if (!hasCalendarConfig()) {
      if (!warnedMissingCalendarConfig) {
        warnedMissingCalendarConfig = true;
        console.log('[calendar] not configured; skipping calendar event creation');
      }
      return { ok: false, reason: 'calendar_not_configured' };
    }
    const calendar = getCalendarClient();
    const calendarId = resolveCalendarId();
    const timing = parseTimingPref(lead.timing_pref);
    if (!timing) { console.error('[calendar] Could not parse timing_pref:', lead.timing_pref); return null; }
    const items = lead.item_list
      ? lead.item_list.split('\n').map(i => i.trim()).filter(Boolean).join(', ')
      : 'See photos';
    const quoteDollars = lead.quote_amount || (lead.quote_total_cents ? Math.round(Number(lead.quote_total_cents) / 100) : null);
    const description = [
      `Phone: ${lead.from_phone}`,
      `Address: ${lead.address || lead.address_text || 'TBD'}`,
      `Load: ${lead.load_bucket || 'TBD'}`,
      `Items: ${items}`,
      `Quote: $${quoteDollars || 'TBD'}`,
      `Window: ${lead.timing_pref}`,
      `Job ID: ${lead.id || lead.from_phone}`
    ].join('\n');
    const event = {
      summary: `ICL Job — ${(lead.address || lead.address_text || lead.from_phone)}`,
      description,
      start: { dateTime: timing.startLocal, timeZone: 'America/Los_Angeles' },
      end: { dateTime: timing.endLocal, timeZone: 'America/Los_Angeles' },
      colorId: '2'
    };
    const res = await calendar.events.insert({ calendarId, resource: event });
    console.log('[calendar] Event created:', res.data.htmlLink);
    return res.data;
  } catch (err) {
    console.error('[calendar] Failed to create event:', err.message);
    return null;
  }
}

async function getBookedWindows(dateStr) {
  try {
    if (!hasCalendarConfig()) return [];
    const isoDate = isoDateFromLabel(dateStr);
    if (!isoDate) return [];
    const range = utcRangeForLaDay(isoDate);
    if (!range) return [];
    const calendar = getCalendarClient();
    const calendarId = resolveCalendarId();
    const res = await calendar.events.list({
      calendarId,
      singleEvents: true,
      orderBy: "startTime",
      timeMin: range.timeMin,
      timeMax: range.timeMax,
      maxResults: 250
    });
    const items = Array.isArray(res?.data?.items) ? res.data.items : [];
    const out = new Set();
    for (const ev of items) {
      const startRaw = ev?.start?.dateTime;
      if (!startRaw) continue;
      const dt = new Date(startRaw);
      if (!Number.isFinite(dt.getTime())) continue;
      const local = laDateAndHour(dt);
      if (local.iso !== isoDate) continue;
      const slot = WINDOW_SLOTS.find((w) => local.hour >= w.start && local.hour < w.end);
      if (slot) out.add(slot.label);
    }
    return Array.from(out);
  } catch (err) {
    console.error("[calendar] getBookedWindows failed:", err?.message || err);
    return [];
  }
}

module.exports = { createJobEvent, getBookedWindows };
