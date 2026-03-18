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
  const envBase2 = String(process.env.BASE_URL || "").trim();
  if (envBase2) return envBase2.replace(/\/+$/, "");
  return `https://${req.headers.host}`;
}

function configuredBaseUrl() {
  const envBase = String(process.env.APP_BASE_URL || process.env.BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  return "https://icl-twilio-intake-production.up.railway.app";
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return null;
}

function phoneFromAnyText(raw) {
  const s = String(raw || "");
  if (!s) return null;
  const m = s.match(/(\+?1?[\s\-.()]?\d{3}[\s\-.()]?\d{3}[\s\-.()]?\d{4})/);
  if (!m) return null;
  return normalizePhone(m[1]);
}

function makeConfirmationId(paymentId, orderId) {
  const raw = String(paymentId || orderId || "").replace(/[^a-zA-Z0-9]/g, "");
  const tail = raw.slice(-6) || String(Date.now()).slice(-6);
  return "ICL-" + tail.toUpperCase();
}

function buildWindowPickerSms({ confirmationId, bookingLink }) {
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
  lines.push("Prefer SMS scheduling? Reply with your arrival window:");
  lines.push("1) 8–10am");
  lines.push("2) 10am–12pm");
  lines.push("3) 12–2pm");
  lines.push("4) 2–4pm");
  lines.push("5) 4–6pm");
  return lines.join("\n");
}

function buildPostPaymentSms({ confirmationId, bookingLink, paymentKind }) {
  const base = buildWindowPickerSms({ confirmationId, bookingLink });
  if (paymentKind === "upfront") {
    return base.replace(
      "Deposit received ✅ You're officially confirmed.",
      "Payment received ✅ You're officially confirmed."
    );
  }
  return base;
}

async function findLeadByOrder(orderId) {
  const byOrder = await pool.query(
    `SELECT *,
            CASE
              WHEN square_upfront_order_id = $1 THEN 'upfront'
              WHEN square_order_id = $1 THEN 'deposit'
              ELSE 'unknown'
            END AS payment_kind
     FROM leads
     WHERE square_order_id = $1
        OR square_upfront_order_id = $1
     ORDER BY last_seen_at DESC
     LIMIT 1`,
    [orderId]
  );
  return byOrder.rows[0] || null;
}

async function findLeadByOrderHistory(orderId) {
  if (!orderId) return null;
  const rows = (
    await pool.query(
      `SELECT e.from_phone, e.payload_json
       FROM events e
       WHERE e.event_type = 'square_quote_created'
         AND e.payload_json LIKE '%' || $1 || '%'
       ORDER BY e.id DESC
       LIMIT 40`,
      [orderId]
    )
  ).rows;

  for (const r of rows) {
    try {
      const payload = JSON.parse(String(r.payload_json || "{}"));
      const depId = String(payload?.deposit?.order_id || "");
      const upId = String(payload?.upfront?.order_id || "");
      if (depId !== orderId && upId !== orderId) continue;
      const phone = String(r.from_phone || "");
      if (!phone) continue;
      const lead = (await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [phone])).rows[0];
      if (!lead) continue;
      return {
        ...lead,
        payment_kind: upId === orderId ? "upfront" : "deposit"
      };
    } catch {}
  }
  return null;
}

async function findLeadByPhoneFallback(phone, paymentKindHint = "deposit") {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const digits = normalized.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return null;
  const row = (
    await pool.query(
      `SELECT *,
              CASE
                WHEN COALESCE(square_upfront_order_id,'') <> '' THEN 'upfront'
                ELSE 'deposit'
              END AS payment_kind
       FROM leads
       WHERE regexp_replace(from_phone, '\\D', '', 'g') LIKE '%' || $1
       ORDER BY
         CASE WHEN deposit_paid = 0 THEN 0 ELSE 1 END,
         last_seen_at DESC
       LIMIT 1`,
      [digits]
    )
  ).rows[0];
  if (!row) return null;
  return {
    ...row,
    payment_kind: paymentKindHint || row.payment_kind || "deposit"
  };
}

async function hasWindowPickerSms(fromPhone) {
  const row = (
    await pool.query(
      `SELECT id
       FROM events
       WHERE from_phone = $1
         AND event_type = 'sms_sent_window_picker'
       ORDER BY id DESC
       LIMIT 1`,
      [fromPhone]
    )
  ).rows[0];
  return !!row;
}

async function processPostPaymentForLead({
  lead,
  orderId,
  paymentId,
  eventType,
  paymentKind = "deposit",
  baseUrl,
  forceSms = false
}) {
  const actions_taken = [];
  const actions_failed = [];

  const alreadyPaid = Number(lead.deposit_paid) === 1;
  const alreadySentWindowPicker = await hasWindowPickerSms(lead.from_phone);
  if (alreadyPaid && alreadySentWindowPicker && !forceSms) {
    return { ok: true, skipped: true, actions_taken: ["already_paid_and_sms_sent"], actions_failed: [] };
  }

  if (!alreadyPaid) {
    await pool.query(
      "UPDATE leads SET deposit_paid=1, deposit_paid_at=COALESCE(deposit_paid_at,NOW()), quote_status='BOOKING_SENT', conv_state='BOOKING_SENT', last_seen_at=NOW() WHERE from_phone=$1",
      [lead.from_phone]
    );
    actions_taken.push("lead_marked_paid");
  } else {
    await pool.query("UPDATE leads SET last_seen_at=NOW() WHERE from_phone=$1", [lead.from_phone]);
    actions_taken.push("lead_touch_last_seen");
  }

  const bookingLink = buildBookingLink(String(baseUrl || configuredBaseUrl()), lead.from_phone);
  const confirmationId = makeConfirmationId(paymentId, orderId);

  if (!alreadyPaid) {
    try {
      insertEvent.run({
        from_phone: lead.from_phone,
        event_type: paymentKind === "upfront" ? "upfront_paid" : "deposit_paid",
        payload_json: JSON.stringify({
          order_id: orderId,
          payment_id: paymentId || null,
          event_type: eventType,
          payment_kind: paymentKind,
          confirmation_id: confirmationId,
          booking_link: bookingLink
        }),
        created_at: new Date().toISOString(),
      });
      actions_taken.push("paid_event_logged");
    } catch (e) {
      actions_failed.push("paid_event_log_failed");
    }
  }

  try {
    const sms = await sendSms(
      lead.from_phone,
      buildPostPaymentSms({ confirmationId, bookingLink, paymentKind })
    );
    try {
      insertEvent.run({
        from_phone: lead.from_phone,
        event_type: "sms_sent_window_picker",
        payload_json: JSON.stringify({ twilio: sms }),
        created_at: new Date().toISOString(),
      });
    } catch {}
    actions_taken.push("window_picker_sms_sent");
  } catch (smsErr) {
    console.error("[square_webhook] post-payment sms failed:", smsErr?.message || smsErr);
    try {
      insertEvent.run({
        from_phone: lead.from_phone,
        event_type: "sms_failed_window_picker",
        payload_json: JSON.stringify({
          error: String(smsErr?.message || smsErr),
          booking_link: bookingLink
        }),
        created_at: new Date().toISOString(),
      });
    } catch {}
    actions_failed.push("window_picker_sms_failed");
  }

  if (!alreadyPaid && String(lead.timing_pref || "").trim()) {
    try {
      await sendCrewBrief(lead);
      actions_taken.push("crew_brief_sent");
    } catch {
      actions_failed.push("crew_brief_failed");
    }
  }
  if (!alreadyPaid) {
    try {
      await processSalvage(lead);
      actions_taken.push("salvage_pipeline_triggered");
    } catch {
      actions_failed.push("salvage_pipeline_failed");
    }
  }

  return {
    ok: true,
    skipped: false,
    confirmation_id: confirmationId,
    booking_link: bookingLink,
    actions_taken,
    actions_failed
  };
}

async function handleSquareWebhook(req, res) {
  try {
    const signature = req.headers["x-square-hmacsha256-signature"] || "";
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const urlCandidates = [
      `https://${req.headers.host}${req.originalUrl}`,
      `${String(process.env.APP_BASE_URL || "").replace(/\/+$/,"")}${req.originalUrl}`,
      `${String(process.env.BASE_URL || "").replace(/\/+$/,"")}${req.originalUrl}`
    ].filter((u, idx, arr) => u && !arr.slice(0, idx).includes(u));

    if (SQUARE_WEBHOOK_SIGNATURE_KEY) {
      const valid = urlCandidates.some((u) => verifySquareSignature(rawBody, signature, u));
      if (!valid) {
        console.error("[square_webhook] Invalid signature");
        return res.status(403).send("Invalid signature");
      }
    }

    const event = req.body;
    const obj = event?.data?.object || {};
    const payment = obj?.payment || obj || {};
    const eventType = event?.type || "";
    const paymentStatus = String(payment?.status || obj?.payment?.status || "").toUpperCase();

    console.log("[square_webhook] event:", eventType, JSON.stringify(event?.data?.object).substring(0, 300));

    const shouldHandlePayment =
      eventType === "payment.completed" ||
      (eventType === "payment.updated" && paymentStatus === "COMPLETED");
    if (!shouldHandlePayment) {
      return res.status(200).send("ok");
    }

    // Extract order_id from event
    let orderId = null;
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

    // Find lead by deposit or upfront order id
    let lead = await findLeadByOrder(orderId);
    if (!lead) {
      lead = await findLeadByOrderHistory(orderId);
    }
    if (!lead) {
      const paymentPhone =
        payment?.buyer_phone_number ||
        payment?.billing_address?.phone_number ||
        phoneFromAnyText(payment?.note) ||
        phoneFromAnyText(payment?.reference_id) ||
        null;
      lead = await findLeadByPhoneFallback(paymentPhone, "deposit");
    }

    if (!lead) {
      console.log("[square_webhook] no lead found for order_id:", orderId);
      try {
        insertEvent.run({
          from_phone: null,
          event_type: "square_webhook_unmatched_payment",
          payload_json: JSON.stringify({
            order_id: orderId,
            payment_id: paymentId,
            event_type: eventType,
            note: payment?.note || null,
            buyer_phone_number: payment?.buyer_phone_number || null
          }),
          created_at: new Date().toISOString()
        });
      } catch {}
      return res.status(200).send("ok");
    }

    const paymentKind = String(lead.payment_kind || "deposit");
    const result = await processPostPaymentForLead({
      lead,
      orderId,
      paymentId,
      eventType,
      paymentKind,
      baseUrl: baseUrlFromReq(req),
      forceSms: false
    });
    if (result.skipped) {
      console.log("[square_webhook] payment already handled for:", lead.from_phone);
    } else {
      console.log("[square_webhook] post-payment actions:", result.actions_taken.join(","));
    }

    return res.status(200).send("ok");

  } catch (e) {
    console.error("[square_webhook] error:", e.message);
    return res.status(200).send("ok"); // always 200 to Square
  }
}

async function simulateDepositForPhone(fromPhone, { baseUrl, forceSms = true } = {}) {
  const lead = (await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [fromPhone])).rows[0];
  if (!lead) {
    return { ok: false, error: "lead_not_found" };
  }
  const orderId = `SIM-${Date.now()}`;
  const paymentId = `SIMPAY-${Date.now()}`;
  const result = await processPostPaymentForLead({
    lead,
    orderId,
    paymentId,
    eventType: "simulate.deposit",
    paymentKind: "deposit",
    baseUrl: String(baseUrl || configuredBaseUrl()),
    forceSms: !!forceSms
  });
  try {
    insertEvent.run({
      from_phone: lead.from_phone,
      event_type: "simulate_deposit",
      payload_json: JSON.stringify({
        order_id: orderId,
        payment_id: paymentId,
        actions_taken: result.actions_taken || [],
        actions_failed: result.actions_failed || []
      }),
      created_at: new Date().toISOString()
    });
  } catch {}
  return result;
}

module.exports = { handleSquareWebhook, simulateDepositForPhone };
