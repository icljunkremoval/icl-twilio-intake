// dropoff_monitor.js - detects stalled leads and sends recovery SMS
const { pool, insertEvent } = require("./db");
const { sendSms } = require("./twilio_sms");

const OPS_PHONE = "+12138806318";

const RECOVERY_MESSAGES = {
  NEW:              "Hey — still thinking about getting rid of some stuff? Text us a photo and we'll have a quote ready in minutes. 📦",
  AWAITING_MEDIA:   "Hey — still thinking about getting rid of some stuff? Text us a photo and we'll have a quote ready in minutes. 📦",
  AWAITING_HAZMAT:  null, // don't auto-recover hazmat
  AWAITING_ADDRESS: "We just need your address to complete your quote — cross streets + ZIP works too. Where's the pickup?",
  AWAITING_ACCESS:  "Almost there! Just need to know the access type: CURB, DRIVEWAY, GARAGE, INSIDE HOME, STAIRS, or APARTMENT.",
  AWAITING_LOAD:    "Last step for your quote — how much are you removing? Reply SMALL, MEDIUM, or LARGE.",
  QUOTE_READY:      null, // quote already sent, don't bug them
  AWAITING_DEPOSIT: null, // they have the link, don't push
};

async function checkDropoffs() {
  const result = await pool.query(`
    SELECT from_phone, conv_state, address_text, last_seen_at
    FROM leads
    WHERE last_seen_at IS NOT NULL
      AND last_seen_at <> ''
      AND last_seen_at::timestamptz < NOW() - INTERVAL '30 minutes'
      AND conv_state NOT IN ('AWAITING_DEPOSIT', 'DEPOSIT_PAID', 'BOOKING_SENT', 'WINDOW_SELECTED', 'ESCALATED', 'QUOTE_READY')
      AND COALESCE(stall_count, 0) < 3
      AND (
        NULLIF(dropoff_alerted_at, '')::timestamptz IS NULL
        OR NULLIF(dropoff_alerted_at, '')::timestamptz < NOW() - INTERVAL '2 hours'
      )
      AND archived_at IS NULL
    ORDER BY last_seen_at::timestamptz DESC
    LIMIT 20
  `);

  const stalled = result.rows;
  if (stalled.length === 0) return;

  console.log(`[dropoff] ${stalled.length} stalled leads`);

  // Alert ops
  const summary = stalled.map(l =>
    `${l.from_phone} — ${l.conv_state} — last seen ${new Date(l.last_seen_at).toLocaleTimeString()}`
  ).join("\n");

  await sendSms(OPS_PHONE,
    `📊 ${stalled.length} stalled lead${stalled.length>1?'s':''}:\n\n${summary}`
  ).catch(() => {});

  // Send recovery SMS to each lead
  for (const lead of stalled) {
    const msg = RECOVERY_MESSAGES[lead.conv_state];
    if (!msg) continue;

    try {
      await sendSms(lead.from_phone, msg);
      await pool.query(
        "UPDATE leads SET dropoff_alerted_at=NOW(), stall_count=COALESCE(stall_count,0)+1 WHERE from_phone=$1",
        [lead.from_phone]
      );
      insertEvent.run({
        from_phone: lead.from_phone,
        event_type: "dropoff_recovery_sent",
        payload_json: JSON.stringify({ conv_state: lead.conv_state }),
        created_at: new Date().toISOString(),
      });
      console.log(`[dropoff] recovery sent to ${lead.from_phone} (${lead.conv_state})`);
    } catch(e) {
      console.error(`[dropoff] error for ${lead.from_phone}:`, e.message);
    }
  }
}

function parseJobEndTime(timingPref) {
  try {
    const raw = String(timingPref || "");
    const match = raw.match(/(\w+\s+\w+\s+\d+),\s*\d+(?:am|pm)-(\d+)(am|pm)/i);
    if (!match) return null;
    const [, dateStr, endHour, endAmPm] = match;
    const year = new Date().getFullYear();
    const base = new Date(`${dateStr} ${year}`);
    let hour = parseInt(endHour, 10);
    if (endAmPm.toLowerCase() === "pm" && hour !== 12) hour += 12;
    if (endAmPm.toLowerCase() === "am" && hour === 12) hour = 0;
    base.setHours(hour, 0, 0, 0);
    return base;
  } catch {
    return null;
  }
}

async function checkPostJobReviews() {
  try {
    const reviewLink = process.env.GOOGLE_REVIEW_LINK || "https://g.page/r/CchfNXDhqlYIEAI/review";
    const result = await pool.query(
      `SELECT from_phone, timing_pref
       FROM leads
       WHERE deposit_paid = 1
         AND timing_pref IS NOT NULL
         AND review_requested_at IS NULL
         AND archived_at IS NULL`
    );
    for (const lead of result.rows) {
      try {
        const endTime = parseJobEndTime(lead.timing_pref);
        if (!endTime) continue;
        const twoHoursAfter = new Date(endTime.getTime() + 2 * 60 * 60 * 1000);
        if (new Date() < twoHoursAfter) continue;
        await sendSms(
          lead.from_phone,
          "One last thing — ICL is growing and we want to reach more people who need us. Your honest account of today's experience is one of the most powerful ways that happens.\n\n" +
          "Would you take 60 seconds? It genuinely makes a difference:\n" +
          reviewLink
        );
        await pool.query("UPDATE leads SET review_requested_at=NOW()::text WHERE from_phone=$1", [lead.from_phone]);
        console.log(`[review] Sent to ${lead.from_phone}`);
      } catch (e) {
        console.error(`[review] Error for ${lead.from_phone}:`, e.message);
      }
    }
  } catch (e) {
    console.error("[review] checkPostJobReviews error:", e.message);
  }
}

module.exports = { checkDropoffs, checkPostJobReviews };
