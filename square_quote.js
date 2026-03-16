const fetch = require("node-fetch");

const SQUARE_API_BASE = "https://connect.squareup.com/v2";
const DEPOSIT_CENTS_DEFAULT = 5000;

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing env: " + name);
  return v;
}

function toMoneyAmount(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) throw new Error("Invalid amount: " + cents);
  const rounded = Math.round(n);
  if (rounded <= 0) throw new Error("Amount must be > 0");
  return rounded;
}

async function createSquareQuickPayLink(lead, opts = {}) {
  const accessToken = must("SQUARE_ACCESS_TOKEN");
  const locationId = must("SQUARE_LOCATION_ID");
  const amountCents = toMoneyAmount(opts.amountCents);
  const idTag = String(opts.idempotencyTag || "checkout").replace(/\s+/g, "_").toLowerCase();

  const idempotencyKey = `icl-${idTag}-${lead.from_phone.replace(/\D/g, "")}-${Date.now()}`;

  const body = {
    idempotency_key: idempotencyKey,
    quick_pay: {
      name: String(opts.name || "ICL Junk Removal Checkout"),
      price_money: {
        amount: amountCents,
        currency: "USD"
      },
      location_id: locationId
    },
    checkout_options: {
      ask_for_shipping_address: false
    },
    pre_populated_data: {
      buyer_phone_number: lead.from_phone
    },
    note: String(opts.note || "").trim() || ("Phone: " + lead.from_phone)
  };

  // Optional redirect. If omitted, Square keeps customer on its receipt/confirmation flow.
  const redirectUrl = String(process.env.SQUARE_REDIRECT_URL || "").trim();
  if (redirectUrl) {
    body.checkout_options.redirect_url = redirectUrl;
  }

  const res = await fetch(SQUARE_API_BASE + "/online-checkout/payment-links", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Content-Type": "application/json",
      "Square-Version": "2024-01-18"
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error("Square API error: " + JSON.stringify(data.errors || data));
  }

  return {
    payment_link_id: data.payment_link.id,
    payment_link_url: data.payment_link.url,
    order_id: data.payment_link.order_id
  };
}

async function createSquarePaymentLink(lead, totalCents) {
  return createSquareQuickPayLink(lead, {
    idempotencyTag: "deposit",
    amountCents: DEPOSIT_CENTS_DEFAULT,
    name: "ICL Junk Removal Deposit",
    note: "Deposit for job. Total: $" + (Number(totalCents || 0) / 100).toFixed(2) + " | Phone: " + lead.from_phone
  });
}

async function createSquarePaymentOptions(
  lead,
  { quoteTotalCents, depositCents = DEPOSIT_CENTS_DEFAULT, upfrontDiscountPct = 10 } = {}
) {
  const quote = toMoneyAmount(quoteTotalCents);
  const pct = Number(upfrontDiscountPct);
  const safePct = Number.isFinite(pct) && pct > 0 ? pct : 10;
  const upfrontTotalCents = Math.max(100, Math.round(quote * (1 - safePct / 100)));

  const deposit = await createSquareQuickPayLink(lead, {
    idempotencyTag: "deposit",
    amountCents: depositCents,
    name: "ICL Junk Removal Deposit",
    note: "Deposit for job. Total: $" + (quote / 100).toFixed(2) + " | Phone: " + lead.from_phone
  });

  const upfront = await createSquareQuickPayLink(lead, {
    idempotencyTag: "upfront",
    amountCents: upfrontTotalCents,
    name: "ICL Junk Removal Pay-in-Full (Save " + safePct + "%)",
    note:
      "Upfront pay-in-full offer. Original: $" +
      (quote / 100).toFixed(2) +
      " | Upfront: $" +
      (upfrontTotalCents / 100).toFixed(2) +
      " | Phone: " +
      lead.from_phone
  });

  return {
    quoteTotalCents: quote,
    upfrontDiscountPct: safePct,
    upfrontTotalCents,
    deposit,
    upfront
  };
}

module.exports = { createSquarePaymentLink, createSquarePaymentOptions };
