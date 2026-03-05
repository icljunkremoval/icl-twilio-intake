// job_complete.js - handles DONE reply from ops, collects diversion data
const { pool, insertEvent } = require("./db");
const { sendSms } = require("./twilio_sms");

const OPS_PHONE = "+12138806318";

async function handleOpsReply(body) {
  const upper = body.trim().toUpperCase();

  // DONE [address or phone] — mark job complete, ask for diversion data
  if (upper.startsWith("DONE")) {
    const identifier = body.trim().slice(4).trim();
    await sendSms(OPS_PHONE,
      `✅ Got it! Quick debrief:\n\nReply with:\nDIVERT [donated items] | [scrap items] | [dump lbs] | [junk fee $]\n\nExample:\nDIVERT couch,dresser | washer | 200 | 45\n\nOr DIVERT NONE if everything went to dump.`
    );
    return { type: "done_ack", identifier };
  }

  // DIVERT [donated] | [scrap] | [dump_lbs] | [fee]
  if (upper.startsWith("DIVERT")) {
    const data = body.trim().slice(6).trim();

    if (data.toUpperCase() === "NONE") {
      await sendSms(OPS_PHONE, "📊 Logged. All to dump. We'll track diversion rate over time.");
      return { type: "divert_none" };
    }

    const parts = data.split("|").map(p => p.trim());
    const donated = parts[0] || "";
    const scrap = parts[1] || "";
    const dumpLbs = parseInt(parts[2]) || 0;
    const junkFee = parseInt(parts[3]) || 0;

    const totalItems = (donated ? donated.split(",").length : 0) + (scrap ? scrap.split(",").length : 0);
    const totalWeight = dumpLbs + (totalItems * 30); // estimate 30lbs per diverted item
    const diversionRate = totalWeight > 0 ? Math.round((totalItems * 30) / totalWeight * 100) : 0;

    // Find most recent completed lead for ops
    const result = await pool.query(`
      SELECT from_phone FROM leads
      WHERE quote_status IN ('DEPOSIT_PAID','BOOKING_SENT','WINDOW_SELECTED')
      ORDER BY deposit_paid_at DESC LIMIT 1
    `);

    if (result.rows.length > 0) {
      const from_phone = result.rows[0].from_phone;
      await pool.query(`
        UPDATE leads SET
          diversion_donated_items=$1,
          diversion_scrap_items=$2,
          diversion_dump_weight_lbs=$3,
          diversion_rate=$4,
          junk_fee_actual=$5,
          quote_status='COMPLETED'
        WHERE from_phone=$6
      `, [donated, scrap, dumpLbs, diversionRate, junkFee * 100, from_phone]);

      insertEvent.run({
        from_phone,
        event_type: "job_completed",
        payload_json: JSON.stringify({ donated, scrap, dumpLbs, junkFee, diversionRate }),
        created_at: new Date().toISOString(),
      });
    }

    const savings = Math.max(0, 360 - junkFee);
    await sendSms(OPS_PHONE,
      `📊 Job logged!\n` +
      `♻️ Donated: ${donated || "none"}\n` +
      `🔩 Scrap: ${scrap || "none"}\n` +
      `🗑️ Dump: ${dumpLbs}lbs @ $${junkFee}\n` +
      `📈 Diversion rate: ${diversionRate}%\n` +
      `💰 Saved vs baseline: $${savings}`
    );

    return { type: "divert_logged", diversionRate, savings };
  }

  // SOLD [item] $[price] — log salvage sale
  if (upper.startsWith("SOLD")) {
    const parts = body.trim().slice(4).trim().split("$");
    const item = parts[0].trim();
    const price = parseInt(parts[1]) || 0;

    // Find most recent lead
    const result = await pool.query(`
      SELECT from_phone FROM leads
      ORDER BY last_seen_at DESC LIMIT 1
    `);

    if (result.rows.length > 0 && price > 0) {
      const from_phone = result.rows[0].from_phone;
      await pool.query(
        "UPDATE leads SET salvage_actual_value=COALESCE(salvage_actual_value,0)+$1 WHERE from_phone=$2",
        [price * 100, from_phone]
      );
      insertEvent.run({
        from_phone,
        event_type: "salvage_sold",
        payload_json: JSON.stringify({ item, price }),
        created_at: new Date().toISOString(),
      });
    }

    await sendSms(OPS_PHONE, `💵 Logged: ${item} sold for $${price}. Nice work.`);
    return { type: "salvage_logged", item, price };
  }

  return null;
}

module.exports = { handleOpsReply };
