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
  const match = timing_pref.match(/(\w+ \w+ \d+),\s*(\d+)(am|pm)-(\d+)(am|pm)/i);
  if (!match) return null;
  const [, dateStr, startHour, startAmPm, endHour, endAmPm] = match;
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
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    console.error("[calendar] GOOGLE_CALENDAR_ID not set");
    return;
  }

  let startISO = lead?.booking_start_iso;
  let endISO = lead?.booking_end_iso;
  if (!startISO || !endISO) {
    console.warn("[calendar] booking_start_iso/end_iso missing — skipping event creation");
    return;
  }

  const calendar = getCalendarClient();
  const event = {
    summary: `ICL Junk — ${lead?.from_phone || "unknown"}`,
    description: [
      `Customer phone: ${lead?.from_phone || ""}`,
      `Address: ${lead?.service_address || lead?.address_text || "TBD"}`,
      `Total: $${((Number(lead?.total_quote_cents || lead?.total_cents || lead?.quote_total_cents || 0)) / 100).toFixed(0)}`,
      lead?.intake_path ? `Path: ${lead.intake_path}` : null,
      lead?.crew_notes ? `Notes: ${lead.crew_notes}` : null,
    ].filter(Boolean).join("\n"),
    location: lead?.service_address || lead?.address_text || "",
    start: { dateTime: startISO, timeZone: "America/Los_Angeles" },
    end: { dateTime: endISO, timeZone: "America/Los_Angeles" },
  };

  try {
    const res = await calendar.events.insert({ calendarId, resource: event });
    console.log("[calendar] event created:", res.data.htmlLink);
    return res.data;
  } catch (e) {
    console.error("[calendar] event error:", e.message);
    throw e;
  }
}

module.exports = { createJobEvent };
