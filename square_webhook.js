// square_webhook.js - handles Square payment webhooks
const crypto = require("crypto");
const { pool, insertEvent } = require("./db");
const { sendCrewBrief } = require("./crew_brief");
const { processSalvage } = require("./salvage_pipeline");
const { sendSms } = require("./twilio_sms");
const { buildBookingLink } = require("./booking_link");

const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";

function verifySquareSignature(body, signature, url) {
  if (!SQUARE_WEBHOOK_SIGNATURE_KEY) return true; // skip in dev
  const hmac = crypto.createHmac("sha256", SQUARE_WEBHOOK_SIGNATURE_KEY);
  hmac.update(url + body);
  const expected = hmac.digest("base64");
  return expected === signature;
}

function baseUrlFromReq(req) {
  const envBase = String(process.env.APP_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  return `https://${req.headers.host}`;
}

function makeConfirmationId(paymentId, orderId) {
  const raw = String(paymentId || orderId || "").replace(/[^a-zA-Z0-9]/g, "");
  const tail = raw.slice(-6) || String(Date.now()).slice(-6);
  return "ICL-" + tail.toUpperCase();
}

function buildWindowPickerSms({ confirmationId, bookingLink }) {
  const storiesUrl = String(process.env.CUSTOMER_STORIES_URL || "").trim();
  const lines = [
    "Deposit received ✅ You're officially confirmed.",
    "",
    "You should receive your Square receipt right away.",
    `Confirmation #: ${confirmationId}`,
    "",
    "What happens next:",
    `1) Pick your time here: ${bookingLink}`,
    "2) We confirm by text",
    "3) Paid → Scheduled → Removed → Complete",
    ""
  ];
  if (storiesUrl) {
    lines.push(`Stories + partners: ${storiesUrl}`);
    lines.push("");
  }
  lines.push("Prefer SMS scheduling? Reply with your arrival window:");
  lines.push("1) 8–10am");
  lines.push("2) 10am–12pm");
  lines.push("3) 12–2pm");
  lines.push("4) 2–4pm");
  lines.push("5) 4–6pm");
  return lines.join("\n");
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

    console.log("[square_webhook] event:", eventType, JSON.stringify(event?.data?.object).substring(0, 300));

    if (eventType !== "payment.completed") {
      return res.status(200).send("ok");
    }

    // Extract order_id from event
    let orderId = null;
    const obj = event?.data?.object || {};
    const payment = obj?.payment || obj || {};
    if (obj?.payment?.order_id) {
      orderId = obj.payment.order_id;
    } else if (obj?.order?.id) {
      orderId = obj.order.id;
    } else if (obj?.order_id) {
      orderId = obj.order_id;
    } else if (event?.data?.id) {
      orderId = event.data.id;
    }
    console.log("[square_webhook] orderId:", orderId, "keys:", Object.keys(obj));

    if (!orderId) {
      console.log("[square_webhook] no order_id found");
      return res.status(200).send("ok");
    }

    const paymentId = String(
      payment?.id ||
      obj?.payment_id ||
      event?.data?.id ||
      ""
    );

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

    const bookingLink = buildBookingLink(baseUrlFromReq(req), lead.from_phone);
    const confirmationId = makeConfirmationId(paymentId, orderId);

    try {
      insertEvent.run({
        from_phone: lead.from_phone,
        event_type: "deposit_paid",
        payload_json: JSON.stringify({
          order_id: orderId,
          payment_id: paymentId || null,
          event_type: eventType,
          confirmation_id: confirmationId,
          booking_link: bookingLink
        }),
        created_at: new Date().toISOString(),
      });
    } catch {}

    // Send post-payment journey + booking guidance SMS
    const sms = await sendSms(
      lead.from_phone,
      buildWindowPickerSms({ confirmationId, bookingLink })
    );
    console.log("[square_webhook] window picker sent to:", lead.from_phone);
    sendCrewBrief(lead).catch(()=>{});
    processSalvage(lead).catch(()=>{});

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
