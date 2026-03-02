const fetch = require("node-fetch");

const SQUARE_API_BASE = "https://connect.squareup.com/v2";

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing env: " + name);
  return v;
}

async function createSquarePaymentLink(lead, totalCents) {
  const accessToken = must("SQUARE_ACCESS_TOKEN");
  const locationId = must("SQUARE_LOCATION_ID");

  const idempotencyKey = "icl-deposit-" + lead.from_phone.replace(/\D/g, "") + "-" + Date.now();

  const body = {
    idempotency_key: idempotencyKey,
    quick_pay: {
      name: "ICL Junk Removal Deposit",
      price_money: {
        amount: 5000,
        currency: "USD"
      },
      location_id: locationId
    },
    checkout_options: {
      redirect_url: "https://icljunkremoval.com",
      ask_for_shipping_address: false
    },
    pre_populated_data: {
      buyer_phone_number: lead.from_phone
    },
    note: "Deposit for job. Total: $" + (totalCents / 100).toFixed(2) + " | Phone: " + lead.from_phone
  };

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

module.exports = { createSquarePaymentLink };
