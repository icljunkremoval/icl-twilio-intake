const { google } = require('googleapis');

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
  const year = new Date().getFullYear();
  const base = new Date(`${dateStr} ${year}`);
  function toHour24(h, ampm) {
    let hour = parseInt(h);
    if (ampm.toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
    return hour;
  }
  const start = new Date(base);
  start.setHours(toHour24(startHour, startAmPm), 0, 0, 0);
  const end = new Date(base);
  end.setHours(toHour24(endHour, endAmPm), 0, 0, 0);
  return { start, end };
}

async function createJobEvent(lead) {
  try {
    const calendar = getCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    const timing = parseTimingPref(lead.timing_pref);
    if (!timing) { console.error('[calendar] Could not parse timing_pref:', lead.timing_pref); return null; }
    const items = lead.item_list
      ? lead.item_list.split('\n').map(i => i.trim()).filter(Boolean).join(', ')
      : 'See photos';
    const description = [
      `Phone: ${lead.from_phone}`,
      `Address: ${lead.address || 'TBD'}`,
      `Load: ${lead.load_bucket || 'TBD'}`,
      `Items: ${items}`,
      `Quote: $${lead.quote_amount || 'TBD'}`,
      `Window: ${lead.timing_pref}`,
      `Job ID: ${lead.id}`
    ].join('\n');
    const event = {
      summary: `ICL Job — ${lead.address || lead.from_phone}`,
      description,
      start: { dateTime: timing.start.toISOString(), timeZone: 'America/Los_Angeles' },
      end: { dateTime: timing.end.toISOString(), timeZone: 'America/Los_Angeles' },
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
