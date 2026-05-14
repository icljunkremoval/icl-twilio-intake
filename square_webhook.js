// square_webhook.js - handles Square payment webhooks
const crypto = require("crypto");
const { pool, insertEvent } = require("./db");
const { sendCrewBrief } = require("./crew_brief");
const { processSalvage } = require("./salvage_pipeline");
const { sendSms } = require("./twilio_sms");
const { recordSettledRevenue } = require("./finance_pipeline");

const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";

function verifySquareSignature(body, signature, url) {
  if (!SQUARE_WEBHOOK_SIGNATURE_KEY) return true; // skip in dev
  const hmac = crypto.createHmac("sha256", SQUARE_WEBHOOK_SIGNATURE_KEY);
  hmac.update(url + body);
  const expected = hmac.digest("base64");
  return expected === signature;
}

function buildWindowPickerSms(paymentKind) {
  const headline =
    paymentKind === "upfront"
      ? "Payment received ✅ Your upfront booking is locked in!"
      : "Deposit received ✅ Your spot is locked in!";
  return (
    headline +
    "\n\nReply with your arrival window:\n1) 8–10am\n2) 10am–12pm\n3) 12–2pm\n4) 2–4pm\n5) 4–6pm"
  );
}

function phoneDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

async function findLeadByOrderOrPhone(orderId, payment) {
  if (orderId) {
    const byOrder = await pool.query(
      `SELECT *,
              CASE
                WHEN square_upfront_order_id = $1 THEN 'order_upfront'
                WHEN square_order_id = $1 THEN 'order_deposit'
                ELSE 'none'
              END AS _match
       FROM leads
       WHERE square_order_id = $1
          OR square_upfront_order_id = $1
       ORDER BY last_seen_at DESC
       LIMIT 1`,
      [orderId]
    );
    if (byOrder.rows[0]) return { lead: byOrder.rows[0], match: byOrder.rows[0]._match || "order_deposit" };
  }
  const pDigits = phoneDigits(
    payment?.buyer_details?.phone_number ||
    payment?.billing_address?.phone_number ||
    payment?.phone_number
  );
  if (pDigits.length >= 10) {
    const byPhone = await pool.query(
      `SELECT *
       FROM leads
       WHERE regexp_replace(from_phone, '\\D', '', 'g') LIKE '%' || $1
       ORDER BY last_seen_at DESC
       LIMIT 1`,
      [pDigits.slice(-10)]
    );
    if (byPhone.rows[0]) return { lead: byPhone.rows[0], match: "phone" };
  }
  return { lead: null, match: "none" };
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

    // Extract order/payment identifiers from event
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
      console.log("[square_webhook] no order_id found; attempting phone fallback");
    }

    const paymentId = String(
      payment?.id ||
      obj?.payment_id ||
      event?.data?.id ||
      ""
    );
    const amountCents = Number(
      payment?.amount_money?.amount ||
      payment?.total_money?.amount ||
      0
    );
    const settledAt = payment?.updated_at || payment?.created_at || new Date().toISOString();

    const { lead, match } = await findLeadByOrderOrPhone(orderId, payment);
    if (!lead) {
      console.log("[square_webhook] no lead found for payment/order:", paymentId, orderId);
      return res.status(200).send("ok");
    }

    // Idempotency guard: ignore replayed payment.completed for same payment_id.
    if (paymentId) {
      const replay = await pool.query(
        `SELECT 1
         FROM events
         WHERE from_phone = $1
           AND event_type = 'settled_revenue_ingested'
           AND payload_json LIKE '%' || $2 || '%'
         LIMIT 1`,
        [lead.from_phone, `"payment_id":"${paymentId}"`]
      );
      if (replay.rows[0]) {
        console.log("[square_webhook] duplicate payment event ignored:", paymentId);
        return res.status(200).send("ok");
      }
    }

    if (Number.isFinite(amountCents) && amountCents > 0) {
      await recordSettledRevenue(lead.from_phone, {
        paymentId,
        orderId,
        amountCents,
        settledAt
      });
    }

    const isReferralLead =
      String(lead.lead_source || "") === "realtor_referral" ||
      String(lead.referral_partner || "") === "realtor_assist";
    const settledRevenueCents = Number.isFinite(amountCents) && amountCents > 0
      ? amountCents
      : Math.max(0, Math.round(Number(lead.settled_revenue_cents || 0)));
    if (isReferralLead && settledRevenueCents > 0) {
      try {
        const payoutCents = Math.max(0, Math.round(settledRevenueCents * 0.10));
        await pool.query(
          "UPDATE leads SET referral_payout_cents=$1, last_seen_at=NOW() WHERE from_phone=$2",
          [payoutCents, lead.from_phone]
        );
        insertEvent.run({
          from_phone: lead.from_phone,
          event_type: "referral_payout_calculated",
          payload_json: JSON.stringify({
            settled_revenue_cents: settledRevenueCents,
            referral_payout_cents: payoutCents,
            partner: "realtor_assist",
          }),
          created_at: new Date().toISOString(),
        });
      } catch (_) {
        // payout tracking should never block webhook completion
      }
    }

    // Booking workflow should only fire from direct order match.
    const isOrderPayment = match === "order_deposit" || match === "order_upfront";
    if (lead.deposit_paid || !isOrderPayment) {
      console.log("[square_webhook] revenue logged; deposit flow skipped", { phone: lead.from_phone, match, deposit_paid: lead.deposit_paid });
      return res.status(200).send("ok");
    }

    const paymentKind = match === "order_upfront" ? "upfront" : "deposit";
    await pool.query(
      `UPDATE leads
       SET deposit_paid=1,
           deposit_paid_at=NOW(),
           quote_status='DEPOSIT_PAID',
           aerial_media_requested=CASE WHEN $2::int = 1 THEN 1 ELSE COALESCE(aerial_media_requested,0) END,
           last_seen_at=NOW()
       WHERE from_phone=$1`,
      [lead.from_phone, isReferralLead ? 1 : 0]
    );

    try {
      insertEvent.run({
        from_phone: lead.from_phone,
        event_type: paymentKind === "upfront" ? "upfront_paid" : "deposit_paid",
        payload_json: JSON.stringify({
          order_id: orderId,
          event_type: eventType,
          payment_id: paymentId,
          amount_cents: amountCents,
          payment_kind: paymentKind
        }),
        created_at: new Date().toISOString(),
      });
    } catch {}

    // Send window picker SMS
    const sms = await sendSms(lead.from_phone, buildWindowPickerSms(paymentKind));
    console.log("[square_webhook] window picker sent to:", lead.from_phone);
    const leadForBrief = { ...lead };
    if (isReferralLead) leadForBrief.aerial_media_requested = 1;
    sendCrewBrief(leadForBrief).catch(()=>{});
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
