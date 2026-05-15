const chrono = require("chrono-node");

const PRESET_WINDOWS = [
  { label: "8-11am", startHour: 8, endHour: 11 },
  { label: "12-3pm", startHour: 12, endHour: 15 },
  { label: "3-6pm", startHour: 15, endHour: 18 },
];

const VAGUE_WINDOW_MAP = {
  morning: { startHour: 8, endHour: 11 },
  afternoon: { startHour: 12, endHour: 15 },
  evening: { startHour: 15, endHour: 18 },
  noon: { startHour: 12, endHour: 15 },
};

const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 20;
const MAX_BOOKING_DAYS_OUT = 14;
const MIN_DURATION_HOURS = 1;
const MAX_DURATION_HOURS = 6;
const DEFAULT_DURATION_HOURS = 3;

/**
 * @param {string} reply
 * @param {Array<{day: string, isoDate: string}>} daySnapshot
 * @returns {{ok: true, day: string, window: string, startISO: string, endISO: string} | {ok: false, reason: string}}
 */
function parseWindowReply(reply, daySnapshot) {
  const trimmed = String(reply || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= 9) {
    if (!Array.isArray(daySnapshot) || daySnapshot.length < 3) {
      return { ok: false, reason: "snapshot_missing" };
    }
    const dayIndex = Math.floor((num - 1) / 3);
    const windowIndex = (num - 1) % 3;
    const day = daySnapshot[dayIndex];
    const window = PRESET_WINDOWS[windowIndex];
    if (!day || !window || !day.isoDate) return { ok: false, reason: "snapshot_invalid" };

    const startISO = combineToISO(day.isoDate, window.startHour, 0);
    const endISO = combineToISO(day.isoDate, window.endHour, 0);
    if (!startISO || !endISO) return { ok: false, reason: "snapshot_invalid" };
    return {
      ok: true,
      day: day.day,
      window: window.label,
      startISO,
      endISO,
    };
  }

  const refDate = new Date();
  const results = chrono.parse(trimmed, refDate, { forwardDate: true });
  if (!results.length) {
    const vague = tryVagueParse(trimmed, refDate);
    if (vague) return vague;
    return { ok: false, reason: "unparseable" };
  }

  const result = results[0];
  const startDate = result.start ? result.start.date() : null;
  const endDate = result.end ? result.end.date() : null;

  if (!startDate) return { ok: false, reason: "no_start" };
  if (!result.start.isCertain("hour")) {
    const vague = tryVagueParse(trimmed, refDate);
    if (vague) return vague;
    return { ok: false, reason: "no_time_specified" };
  }

  const resolvedStart = startDate;
  let resolvedEnd = endDate;
  if (!resolvedEnd) {
    resolvedEnd = new Date(resolvedStart.getTime() + DEFAULT_DURATION_HOURS * 3600 * 1000);
  }

  const validation = validateWindow(resolvedStart, resolvedEnd, refDate);
  if (!validation.ok) return validation;

  return {
    ok: true,
    day: formatDayLabel(resolvedStart),
    window: formatWindowLabel(resolvedStart, resolvedEnd),
    startISO: resolvedStart.toISOString(),
    endISO: resolvedEnd.toISOString(),
  };
}

function tryVagueParse(text, refDate) {
  const lower = text.toLowerCase();
  for (const [keyword, window] of Object.entries(VAGUE_WINDOW_MAP)) {
    if (lower.includes(keyword)) {
      const stripped = lower.replace(keyword, "").trim();
      if (!stripped) return null;
      const results = chrono.parse(stripped, refDate, { forwardDate: true });
      if (!results.length) return null;
      const day = results[0].start.date();
      const start = new Date(day);
      start.setHours(window.startHour, 0, 0, 0);
      const end = new Date(day);
      end.setHours(window.endHour, 0, 0, 0);
      const validation = validateWindow(start, end, refDate);
      if (!validation.ok) return validation;
      return {
        ok: true,
        day: formatDayLabel(start),
        window: formatWindowLabel(start, end),
        startISO: start.toISOString(),
        endISO: end.toISOString(),
      };
    }
  }
  return null;
}

function validateWindow(start, end, refDate) {
  if (start <= refDate) return { ok: false, reason: "in_past" };
  const daysOut = (start - refDate) / (1000 * 60 * 60 * 24);
  if (daysOut > MAX_BOOKING_DAYS_OUT) return { ok: false, reason: "too_far_out" };

  const startHour = start.getHours();
  const endHour = end.getHours() + (end.getMinutes() > 0 ? 1 : 0);
  if (startHour < BUSINESS_START_HOUR) return { ok: false, reason: "before_hours" };
  if (endHour > BUSINESS_END_HOUR) return { ok: false, reason: "after_hours" };

  const durationHours = (end - start) / (1000 * 60 * 60);
  if (durationHours < MIN_DURATION_HOURS) return { ok: false, reason: "too_short" };
  if (durationHours > MAX_DURATION_HOURS) return { ok: false, reason: "too_long" };

  return { ok: true };
}

function combineToISO(isoDateString, hour, minute) {
  const d = new Date(isoDateString + "T00:00:00");
  if (!Number.isFinite(d.getTime())) return null;
  d.setHours(hour, minute, 0, 0);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

function formatDayLabel(date) {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${dayNames[date.getDay()]} ${monthNames[date.getMonth()]} ${date.getDate()}`;
}

function formatWindowLabel(start, end) {
  const fmt = (d) => {
    const h = d.getHours();
    const m = d.getMinutes();
    const period = h >= 12 ? "pm" : "am";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, "0")}${period}`;
  };
  return `${fmt(start)}-${fmt(end)}`;
}

function generateDaySnapshot(refDate = new Date()) {
  const days = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(refDate);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    days.push({
      day: formatDayLabel(d),
      isoDate: d.toISOString().slice(0, 10),
    });
  }
  return days;
}

module.exports = { parseWindowReply, generateDaySnapshot, PRESET_WINDOWS };
