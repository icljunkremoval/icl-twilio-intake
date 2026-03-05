// dropoff_monitor.js - detects stalled leads and sends recovery SMS
const { pool, insertEvent } = require("./db");
const { sendSms } = require("./twilio_sms");

const OPS_PHONE = "+12138806318";
const STALL_MINUTES = 30;

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
  const cutoff = new Date(Date.now() - STALL_MINUTES * 60 * 1000).toISOString();

  const result = await pool.query(`
    SELECT from_phone, conv_state, address_text, last_seen_at
    FROM leads
    WHERE last_seen_at < $1
      AND conv_state NOT IN ('AWAITING_DEPOSIT', 'DEPOSIT_PAID', 'BOOKING_SENT', 'WINDOW_SELECTED', 'ESCALATED', 'QUOTE_READY')
      AND dropoff_alerted_at IS NULL
    ORDER BY last_seen_at DESC
    LIMIT 20
  `, [cutoff]);

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
        "UPDATE leads SET dropoff_alerted_at=NOW() WHERE from_phone=$1",
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

module.exports = { checkDropoffs };
