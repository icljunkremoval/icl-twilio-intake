const chrono = require('chrono-node');
const { DateTime } = require('luxon');

const TZ = 'America/Los_Angeles';

const PRESET_WINDOWS = [
  { label: '8-11am',  startHour: 8,  endHour: 11 },
  { label: '12-3pm',  startHour: 12, endHour: 15 },
  { label: '3-6pm',   startHour: 15, endHour: 18 },
];

const VAGUE_WINDOW_MAP = {
  morning:    { startHour: 8,  endHour: 11 },
  afternoon:  { startHour: 12, endHour: 15 },
  evening:    { startHour: 15, endHour: 18 },
  noon:       { startHour: 12, endHour: 15 },
};

const BUSINESS_START_HOUR = 8;   // 8am PT
const BUSINESS_END_HOUR   = 20;  // 8pm PT
const MAX_BOOKING_DAYS_OUT = 14;
const MIN_DURATION_HOURS = 1;
const MAX_DURATION_HOURS = 6;
const DEFAULT_DURATION_HOURS = 3;

/**
 * Construct a UTC ISO string representing a moment in Pacific Time.
 * Bulletproof against process.env.TZ — works regardless of server timezone.
 *
 * Example: combineToISO('2026-05-17', 12, 0) → "2026-05-17T19:00:00.000Z" (during PDT)
 */
function combineToISO(isoDateString, hour, minute) {
  const [year, month, day] = isoDateString.split('-').map(Number);
  const dt = DateTime.fromObject(
    { year, month, day, hour, minute },
    { zone: TZ }
  );
  if (!dt.isValid) {
    throw new Error(`combineToISO: invalid date ${isoDateString} ${hour}:${minute}`);
  }
  return dt.toUTC().toISO();
}

/**
 * Reinterpret a JavaScript Date returned from chrono as Pacific Time wall-clock.
 *
 * chrono returns Date objects in the server's local zone. On a UTC server,
 * "Saturday 10am" → Date representing Sat 10:00 UTC. We want to treat the
 * displayed wall-clock fields (year/month/day/hour/minute) as if they were
 * Pacific Time, then convert to a correct UTC moment.
 */
function chronoDateToPT(jsDate) {
  return DateTime.fromObject({
    year: jsDate.getUTCFullYear(),
    month: jsDate.getUTCMonth() + 1, // luxon is 1-indexed
    day: jsDate.getUTCDate(),
    hour: jsDate.getUTCHours(),
    minute: jsDate.getUTCMinutes(),
  }, { zone: TZ });
}

/**
 * Validate that a window falls within business hours and reasonable bounds.
 * All comparisons happen in Pacific Time.
 */
function validateWindow(startDT, endDT) {
  if (!startDT.isValid) return { ok: false, reason: 'invalid_start' };
  if (!endDT.isValid)   return { ok: false, reason: 'invalid_end' };

  const nowPT = DateTime.now().setZone(TZ);
  if (startDT <= nowPT) return { ok: false, reason: 'in_past' };

  const daysOut = startDT.diff(nowPT, 'days').days;
  if (daysOut > MAX_BOOKING_DAYS_OUT) return { ok: false, reason: 'too_far_out' };

  if (startDT.hour < BUSINESS_START_HOUR) return { ok: false, reason: 'before_hours' };

  const endsAfterBusiness =
    endDT.hour > BUSINESS_END_HOUR ||
    (endDT.hour === BUSINESS_END_HOUR && endDT.minute > 0);
  if (endsAfterBusiness) return { ok: false, reason: 'after_hours' };

  const durationHours = endDT.diff(startDT, 'hours').hours;
  if (durationHours < MIN_DURATION_HOURS) return { ok: false, reason: 'too_short' };
  if (durationHours > MAX_DURATION_HOURS) return { ok: false, reason: 'too_long' };

  return { ok: true };
}

function formatDayLabel(dt) {
  // e.g. "Sat May 16"
  return dt.toFormat('ccc LLL d');
}

function formatWindowLabel(startDT, endDT) {
  const fmt = (dt) => {
    const h = dt.hour;
    const m = dt.minute;
    const period = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2,'0')}${period}`;
  };
  return `${fmt(startDT)}-${fmt(endDT)}`;
}

/**
 * Parse a customer reply into a booking window.
 */
function parseWindowReply(reply, daySnapshot) {
  const trimmed = String(reply || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  // Path A: numeric reply 1-9
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= 9 && /^\d+$/.test(trimmed)) {
    if (!Array.isArray(daySnapshot) || daySnapshot.length < 3) {
      return { ok: false, reason: 'snapshot_missing' };
    }
    const dayIndex = Math.floor((num - 1) / 3);
    const windowIndex = (num - 1) % 3;
    const day = daySnapshot[dayIndex];
    const window = PRESET_WINDOWS[windowIndex];
    if (!day || !window) return { ok: false, reason: 'snapshot_invalid' };

    const startISO = combineToISO(day.isoDate, window.startHour, 0);
    const endISO   = combineToISO(day.isoDate, window.endHour, 0);
    return {
      ok: true,
      day: day.day,
      window: window.label,
      startISO,
      endISO,
    };
  }

  // Path B: natural language parse via chrono
  const refDate = new Date();
  const results = chrono.parse(trimmed, refDate, { forwardDate: true });
  if (!results.length) {
    const vague = tryVagueParse(trimmed, refDate);
    if (vague) return vague;
    return { ok: false, reason: 'unparseable' };
  }

  const result = results[0];
  if (!result.start) return { ok: false, reason: 'no_start' };
  if (!result.start.isCertain('hour')) {
    return { ok: false, reason: 'no_time_specified' };
  }

  const startJS = result.start.date();
  const endJS   = result.end ? result.end.date() : null;

  let startDT = chronoDateToPT(startJS);
  let endDT;

  if (endJS) {
    endDT = chronoDateToPT(endJS);
  } else {
    endDT = startDT.plus({ hours: DEFAULT_DURATION_HOURS });
  }

  const validation = validateWindow(startDT, endDT);
  if (!validation.ok) return validation;

  return {
    ok: true,
    day: formatDayLabel(startDT),
    window: formatWindowLabel(startDT, endDT),
    startISO: startDT.toUTC().toISO(),
    endISO:   endDT.toUTC().toISO(),
  };
}

function tryVagueParse(text, refDate) {
  const lower = text.toLowerCase();
  for (const [keyword, window] of Object.entries(VAGUE_WINDOW_MAP)) {
    if (lower.includes(keyword)) {
      const stripped = lower.replace(keyword, '').trim();
      if (!stripped) return null;
      const results = chrono.parse(stripped, refDate, { forwardDate: true });
      if (!results.length) return null;

      const dayPT = chronoDateToPT(results[0].start.date());
      const startDT = dayPT.set({ hour: window.startHour, minute: 0, second: 0, millisecond: 0 });
      const endDT   = dayPT.set({ hour: window.endHour,   minute: 0, second: 0, millisecond: 0 });

      const validation = validateWindow(startDT, endDT);
      if (!validation.ok) return validation;

      return {
        ok: true,
        day: formatDayLabel(startDT),
        window: formatWindowLabel(startDT, endDT),
        startISO: startDT.toUTC().toISO(),
        endISO:   endDT.toUTC().toISO(),
      };
    }
  }
  return null;
}

/**
 * Generate the next 3 booking days starting from tomorrow (in PT).
 * Returns array of { day: "Sat May 16", isoDate: "2026-05-16" }.
 */
function generateDaySnapshot() {
  const days = [];
  const tomorrowPT = DateTime.now().setZone(TZ).plus({ days: 1 }).startOf('day');
  for (let i = 0; i < 3; i++) {
    const d = tomorrowPT.plus({ days: i });
    days.push({
      day: formatDayLabel(d),
      isoDate: d.toFormat('yyyy-MM-dd'),
    });
  }
  return days;
}

module.exports = { parseWindowReply, generateDaySnapshot, PRESET_WINDOWS };
