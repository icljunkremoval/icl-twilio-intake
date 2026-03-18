const { google } = require('googleapis');

let warnedMissingCalendarConfig = false;
// Default calendar requested for scheduled jobs visibility.
const DEFAULT_GROUP_CALENDAR_ID =
  "c_55b6a7c060862d8a44bb038ae4d0b7f1553c35e69ccd37fe2960aebcf661a891@group.calendar.google.com";

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

module.exports = { createJobEvent };
