// square_webhook.js - handles Square payment webhooks
const crypto = require("crypto");
const twilio = require("twilio");
const { pool, insertEvent } = require("./db");
const { sendCrewBrief } = require("./crew_brief");
const { processSalvage } = require("./salvage_pipeline");
const { sendSms } = require("./twilio_sms");
const { recordSettledRevenue } = require("./finance_pipeline");
const { generateDaySnapshot, PRESET_WINDOWS } = require("./window_parser");

const SQUARE_WEBHOOK_SIGNATURE_KEY = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || "";
const POST_PAYMENT_REFERRAL_TIMEOUT_MS = 10 * 60 * 1000;
const postPaymentReferralTimers = new Map();
const APP_BASE_URL = String(process.env.BASE_URL || process.env.APP_BASE_URL || "https://icl-twilio-intake-production.up.railway.app").replace(/\/+$/, "");

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

function buildBookingConfirmedSms(paymentKind) {
  return paymentKind === "upfront"
    ? "Payment received ✅ Your upfront booking is locked in!"
    : "Deposit received ✅ Your spot is locked in!";
}

function buildDayOptions(now = new Date()) {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const options = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    options.push(`${dayNames[d.getDay()]} ${monthNames[d.getMonth()]} ${d.getDate()}`);
  }
  return options;
}

function buildDepositDayPickerSms(paymentKind, dayOptions) {
  const headline = buildBookingConfirmedSms(paymentKind);
  return (
    `${headline}\n\n` +
    `When works best for the crew? Tap a day:\n` +
    `1) ${dayOptions[0]}\n` +
    `2) ${dayOptions[1]}\n` +
    `3) ${dayOptions[2]}`
  );
}

function clearPostPaymentReferralTimeout(from_phone) {
  const key = String(from_phone || "");
  const timer = postPaymentReferralTimers.get(key);
  if (timer) clearTimeout(timer);
  postPaymentReferralTimers.delete(key);
}

function schedulePostPaymentReferralTimeout(from_phone) {
  clearPostPaymentReferralTimeout(from_phone);
  const key = String(from_phone || "");
  const timer = setTimeout(async () => {
    try {
      const leadRes = await pool.query("SELECT conv_state FROM leads WHERE from_phone=$1", [from_phone]);
      const state = String(leadRes.rows[0]?.conv_state || "");
      if (state !== "AWAITING_POST_PAYMENT_REFERRAL") return;
      await pool.query(
        "UPDATE leads SET conv_state='BOOKING_SENT', quote_status='BOOKING_SENT', last_seen_at=NOW() WHERE from_phone=$1",
        [from_phone]
      );
      await sendSms(
        from_phone,
        "Reply with your arrival window:\n1) 8–10am\n2) 10am–12pm\n3) 12–2pm\n4) 2–4pm\n5) 4–6pm"
      );
      insertEvent.run({
        from_phone,
        event_type: "post_payment_referral_timeout_to_booking",
        payload_json: JSON.stringify({ from_phone }),
        created_at: new Date().toISOString(),
      });
    } catch (_) {}
    clearPostPaymentReferralTimeout(from_phone);
  }, POST_PAYMENT_REFERRAL_TIMEOUT_MS);
  postPaymentReferralTimers.set(key, timer);
}

async function sendContactCardMms(toPhone) {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || "");
  const token = String(process.env.TWILIO_AUTH_TOKEN || "");
  if (!sid || !token) throw new Error("missing_twilio_credentials_for_mms");
  const client = twilio(sid, token);
  const messagingServiceSid = String(process.env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
  const from = String(process.env.TWILIO_FROM_NUMBER || "").trim();
  const payload = {
    to: toPhone,
    body: "Save our contact for the day-of crew.",
    mediaUrl: [`${APP_BASE_URL}/contact.vcf`],
  };
  if (messagingServiceSid) payload.messagingServiceSid = messagingServiceSid;
  else if (from) payload.from = from;
  else throw new Error("missing_twilio_sender_for_mms");
  return client.messages.create(payload);
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

async function loadLeadByPhone(from_phone) {
  const rows = await pool.query("SELECT * FROM leads WHERE from_phone=$1 LIMIT 1", [from_phone]);
  return rows.rows[0] || null;
}

/**
 * Run all post-deposit side effects for a lead.
 * Used by both the real Square webhook and admin simulation endpoint.
 */
async function processDepositCompletion(lead, opts = {}) {
  const from_phone = String(lead?.from_phone || "");
  if (!from_phone) throw new Error("missing_from_phone");

  const isTest = !!opts.isTest;
  const paymentKind = String(opts.paymentKind || "deposit") === "upfront" ? "upfront" : "deposit";
  const isReferralLead = opts.isReferralLead !== undefined
    ? !!opts.isReferralLead
    : (
      String(lead?.lead_source || "") === "realtor_referral" ||
      String(lead?.referral_partner || "") === "realtor_assist"
    );
  const totalCents = Math.max(
    0,
    Math.round(Number(lead?.total_cents || lead?.quote_total_cents || 0))
  );
  const resolvedAmountCents = Number.isFinite(Number(opts.amountCents)) && Number(opts.amountCents) > 0
    ? Math.round(Number(opts.amountCents))
    : Math.max(0, Math.round(totalCents / 2));

  await pool.query(
    `UPDATE leads
     SET deposit_paid=1,
         deposit_paid_at=NOW(),
         deposit_paid_amount_cents=$2,
         is_test_payment=$3,
         quote_status='DEPOSIT_PAID',
         aerial_media_requested=CASE WHEN $4::int = 1 THEN 1 ELSE COALESCE(aerial_media_requested,0) END,
         last_seen_at=NOW()
     WHERE from_phone=$1`,
    [from_phone, resolvedAmountCents, isTest ? true : false, isReferralLead ? 1 : 0]
  );

  try {
    insertEvent.run({
      from_phone,
      event_type: paymentKind === "upfront" ? "upfront_paid" : "deposit_paid",
      payload_json: JSON.stringify({
        order_id: opts.orderId || null,
        event_type: opts.eventType || "payment.completed",
        payment_id: opts.paymentId || null,
        amount_cents: resolvedAmountCents,
        payment_kind: paymentKind,
        is_test_payment: isTest,
      }),
      created_at: new Date().toISOString(),
    });
  } catch {}

  const daySnapshot = generateDaySnapshot();
  await pool.query(
    `UPDATE leads
     SET day_options_snapshot=$2,
         day_options_snapshot_at=NOW(),
         quote_status='BOOKING_SENT',
         conv_state='AWAITING_DAY',
         last_seen_at=NOW()
     WHERE from_phone=$1`,
    [from_phone, JSON.stringify(daySnapshot)]
  );

  const lines = [];
  lines.push("Deposit received — your spot is locked in.");
  lines.push("");
  daySnapshot.forEach((day, dayIdx) => {
    lines.push(day.day);
    PRESET_WINDOWS.forEach((win, winIdx) => {
      const num = dayIdx * 3 + winIdx + 1;
      lines.push(`${num} — ${win.label}`);
    });
    lines.push("");
  });
  lines.push("To book your service window, reply with a number. If that doesn't work, feel free to text a date & time that works for you.");
  const pickerBody = lines.join("\n");
  const sms = await sendSms(from_phone, pickerBody);
  try {
    const vcardMms = await sendContactCardMms(from_phone);
    insertEvent.run({
      from_phone,
      event_type: "sms_sent_contact_vcard",
      payload_json: JSON.stringify({ sid: vcardMms?.sid || null }),
      created_at: new Date().toISOString(),
    });
  } catch (vcardErr) {
    console.error("[square_webhook] contact vcard MMS failed:", vcardErr?.message || vcardErr);
  }

  const leadForBrief = { ...(await loadLeadByPhone(from_phone) || lead) };
  if (isReferralLead) leadForBrief.aerial_media_requested = 1;
  sendCrewBrief(leadForBrief).catch(()=>{});
  processSalvage(leadForBrief).catch(()=>{});

  clearPostPaymentReferralTimeout(from_phone);

  try {
    insertEvent.run({
      from_phone,
      event_type: "sms_sent_day_picker",
      payload_json: JSON.stringify({ twilio: sms, payment_kind: paymentKind, is_test_payment: isTest }),
      created_at: new Date().toISOString(),
    });
  } catch {}

  return {
    ok: true,
    from_phone,
    payment_kind: paymentKind,
    amount_cents: resolvedAmountCents,
    is_test_payment: isTest,
    day_options: daySnapshot,
    next_state: "AWAITING_DAY",
  };
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
    await processDepositCompletion(lead, {
      isTest: false,
      amountCents,
      paymentKind,
      orderId,
      paymentId,
      eventType,
      isReferralLead,
    });

    return res.status(200).send("ok");

  } catch (e) {
    console.error("[square_webhook] error:", e.message);
    return res.status(200).send("ok"); // always 200 to Square
  }
}

module.exports = { handleSquareWebhook, processDepositCompletion };
