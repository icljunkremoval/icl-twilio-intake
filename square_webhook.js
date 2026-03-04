// square_webhook.js - handles Square payment webhooks
const crypto = require("crypto");
const { pool, insertEvent } = require("./db");
const { sendSms } = require("./twilio_sms");

const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";

function verifySquareSignature(body, signature, url) {
  if (!SQUARE_WEBHOOK_SIGNATURE_KEY) return true; // skip in dev
  const hmac = crypto.createHmac("sha256", SQUARE_WEBHOOK_SIGNATURE_KEY);
  hmac.update(url + body);
  const expected = hmac.digest("base64");
  return expected === signature;
}

function buildWindowPickerSms() {
  return "Deposit received ✅ Your spot is locked in!\n\nReply with your arrival window:\n1) 9–11am\n2) 12–2pm\n3) 3–5pm";
}

async function handleSquareWebhook(req, res) {
  try {
    const signature = req.headers["x-square-hmacsha256-signature"] || "";
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const url = `https://${req.headers.host}${req.originalUrl}`;

    if (SQUARE_WEBHOOK_SIGNATURE_KEY && !verifySquareSignature(rawBody, signature, url)) {
      console.error("[square_webhook] Invalid signature");
      return res.status(403).send("Invalid signature");
    }

    const event = req.body;
    const eventType = event?.type || "";

    console.log("[square_webhook] event:", eventType);

    if (eventType !== "payment.completed" && eventType !== "order.updated") {
      return res.status(200).send("ok");
    }

    // Extract order_id from event
    let orderId = null;
    if (event?.data?.object?.payment?.order_id) {
      orderId = event.data.object.payment.order_id;
    } else if (event?.data?.object?.order?.id) {
      orderId = event.data.object.order.id;
    }

    if (!orderId) {
      console.log("[square_webhook] no order_id found");
      return res.status(200).send("ok");
    }

    // Find lead by square_order_id
    const result = await pool.query(
      "SELECT * FROM leads WHERE square_order_id = $1",
      [orderId]
    );
    const lead = result.rows[0];

    if (!lead) {
      console.log("[square_webhook] no lead found for order_id:", orderId);
      return res.status(200).send("ok");
    }

    if (lead.deposit_paid) {
      console.log("[square_webhook] deposit already recorded for:", lead.from_phone);
      return res.status(200).send("ok");
    }

    // Mark deposit paid
    await pool.query(
      "UPDATE leads SET deposit_paid=1, deposit_paid_at=NOW(), quote_status='DEPOSIT_PAID', last_seen_at=NOW() WHERE from_phone=$1",
      [lead.from_phone]
    );

    try {
      insertEvent.run({
        from_phone: lead.from_phone,
        event_type: "deposit_paid",
        payload_json: JSON.stringify({ order_id: orderId, event_type: eventType }),
        created_at: new Date().toISOString(),
      });
    } catch {}

    // Send window picker SMS
    const sms = await sendSms(lead.from_phone, buildWindowPickerSms());
    console.log("[square_webhook] window picker sent to:", lead.from_phone);

    await pool.query(
      "UPDATE leads SET quote_status='BOOKING_SENT', conv_state='BOOKING_SENT', last_seen_at=NOW() WHERE from_phone=$1",
      [lead.from_phone]
    );

    try {
      insertEvent.run({
        from_phone: lead.from_phone,
        event_type: "sms_sent_window_picker",
        payload_json: JSON.stringify({ twilio: sms }),
        created_at: new Date().toISOString(),
      });
    } catch {}

    return res.status(200).send("ok");

  } catch (e) {
    console.error("[square_webhook] error:", e.message);
    return res.status(200).send("ok"); // always 200 to Square
  }
}

module.exports = { handleSquareWebhook };
