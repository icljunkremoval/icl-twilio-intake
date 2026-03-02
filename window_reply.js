const { db, insertEvent } = require("./db");
const { sendSms } = require("./twilio_sms");

const STATUS_BOOKING_SENT = "BOOKING_SENT";
const STATUS_WINDOW_SELECTED = "WINDOW_SELECTED";

function parseWindow(body) {
  const t = String(body || "").trim().toLowerCase();
  if (t === "1" || (t.includes("9") && t.includes("11"))) return "9-11";
  if (t === "2" || (t.includes("12") && t.includes("2"))) return "12-2";
  if (t === "3" || (t.includes("3") && t.includes("5"))) return "3-5";
  return null;
}

function confirmSms(window) {
  return `Locked ✅ Arrival window: ${window}. Reply CHANGE if you need to switch.`;
}

async function handleWindowReply({ from_phone, body }) {
  const window = parseWindow(body);
  if (!window) return { handled: false };

  const lead = db
    .prepare("SELECT from_phone, quote_status FROM leads WHERE from_phone = ?")
    .get(from_phone);
  if (!lead) return { handled: false };

  if (String(lead.quote_status || "") !== STATUS_BOOKING_SENT) return { handled: false };

  db.prepare(`
    UPDATE leads
    SET timing_pref = ?,
        quote_status = ?,
        last_seen_at = datetime('now')
    WHERE from_phone = ?
  `).run(window, STATUS_WINDOW_SELECTED, from_phone);

  try {
    insertEvent.run({
      from_phone,
      event_type: "window_selected",
      payload_json: JSON.stringify({ window }),
      created_at: new Date().toISOString(),
    });
  } catch {}

  const sms = await sendSms(from_phone, confirmSms(window));
  try {
    insertEvent.run({
      from_phone,
      event_type: "sms_sent_window_confirm",
      payload_json: JSON.stringify({ window, twilio: sms }),
      created_at: new Date().toISOString(),
    });
  } catch {}

  return { handled: true, window };
}

module.exports = { handleWindowReply };
