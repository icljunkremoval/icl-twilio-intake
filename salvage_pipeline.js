// salvage_pipeline.js - generates FB Marketplace listings from vision analysis
const { pool, insertEvent } = require("./db");
const { sendSms } = require("./twilio_sms");
const fetch = require("node-fetch");

const OPS_PHONE = "+12138806318";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

// Price estimates for common resell items
const SALVAGE_PRICE_GUIDE = {
  // Furniture
  "couch": { min: 50, max: 200, category: "Furniture" },
  "sofa": { min: 50, max: 200, category: "Furniture" },
  "chair": { min: 20, max: 100, category: "Furniture" },
  "dresser": { min: 40, max: 150, category: "Furniture" },
  "table": { min: 30, max: 200, category: "Furniture" },
  "desk": { min: 30, max: 150, category: "Furniture" },
  "bookshelf": { min: 20, max: 80, category: "Furniture" },
  "bed frame": { min: 40, max: 150, category: "Furniture" },
  "cabinet": { min: 30, max: 120, category: "Furniture" },
  // Appliances
  "refrigerator": { min: 50, max: 200, category: "Appliances" },
  "washer": { min: 50, max: 150, category: "Appliances" },
  "dryer": { min: 50, max: 150, category: "Appliances" },
  "microwave": { min: 15, max: 50, category: "Appliances" },
  "fan": { min: 10, max: 40, category: "Appliances" },
  "air conditioner": { min: 40, max: 150, category: "Appliances" },
  // Electronics
  "tv": { min: 20, max: 150, category: "Electronics" },
  "television": { min: 20, max: 150, category: "Electronics" },
  "monitor": { min: 20, max: 100, category: "Electronics" },
  "speaker": { min: 10, max: 80, category: "Electronics" },
  // Equipment
  "bike": { min: 30, max: 150, category: "Sporting Goods" },
  "bicycle": { min: 30, max: 150, category: "Sporting Goods" },
  "treadmill": { min: 50, max: 200, category: "Sporting Goods" },
  "hand truck": { min: 20, max: 60, category: "Tools" },
  "dolly": { min: 20, max: 60, category: "Tools" },
  "ladder": { min: 20, max: 80, category: "Tools" },
  // Scrap metal
  "metal": { min: 10, max: 50, category: "Scrap" },
};

function estimateSalvageValue(items) {
  let total = 0;
  const flagged = [];

  for (const item of items) {
    const itemLower = item.toLowerCase();
    for (const [keyword, data] of Object.entries(SALVAGE_PRICE_GUIDE)) {
      if (itemLower.includes(keyword)) {
        const midpoint = Math.round((data.min + data.max) / 2);
        total += midpoint;
        flagged.push({ item, category: data.category, est_value: midpoint, min: data.min, max: data.max });
        break;
      }
    }
  }

  return { total_est: total, items: flagged };
}

async function generateFBListing(item, condition_notes) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const prompt = `Generate a Facebook Marketplace listing for this junk removal salvage item.

Item: ${item.item}
Estimated value: $${item.est_value}
Condition notes: ${condition_notes || "Unknown condition, sold as-is"}

Respond ONLY with JSON:
{
  "title": "short punchy title under 50 chars",
  "price": number (between ${item.min} and ${item.max}),
  "description": "2-3 sentence description, honest about condition, mention pickup only, sold as-is",
  "category": "${item.category}",
  "condition": "Good" or "Fair" or "Poor - Parts Only"
}`;

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch(e) {
    return null;
  }
}

async function processSalvage(lead) {
  try {
    const vision = typeof lead.vision_analysis === "string"
      ? JSON.parse(lead.vision_analysis)
      : (lead.vision_analysis || {});

    const resellItems = vision.resell_items || [];
    const allItems = vision.items || [];
    const targetItems = resellItems.length > 0 ? resellItems : allItems;

    if (targetItems.length === 0) return;

    const salvage = estimateSalvageValue(targetItems);
    if (salvage.items.length === 0) return;

    // Generate listings for top 3 items
    const topItems = salvage.items.slice(0, 3);
    const listings = [];

    for (const item of topItems) {
      const listing = await generateFBListing(item, vision.crew_notes);
      if (listing) listings.push({ ...listing, original_item: item.item });
    }

    if (listings.length === 0) return;

    // Store salvage data
    await pool.query(
      "UPDATE leads SET salvage_items=$1, salvage_est_value=$2 WHERE from_phone=$3",
      [JSON.stringify(salvage.items), salvage.total_est, lead.from_phone]
    ).catch(() => {});

    // Send SMS to ops with listings ready to post
    const lines = [
      `♻️ SALVAGE ALERT — Est. $${salvage.total_est}`,
      `Job: ${lead.address_text || lead.from_phone}`,
      ""
    ];

    for (const l of listings) {
      lines.push(`📦 ${l.title}`);
      lines.push(`💰 $${l.price} — ${l.condition}`);
      lines.push(l.description);
      lines.push("");
    }

    lines.push("Post to FB Marketplace before disposal.");
    lines.push("Reply SOLD [item] $[price] to log it.");

    await sendSms(OPS_PHONE, lines.join("\n"));
    console.log("[salvage] listings sent for", lead.from_phone, "est $" + salvage.total_est);

    insertEvent.run({
      from_phone: lead.from_phone,
      event_type: "salvage_listings_generated",
      payload_json: JSON.stringify({ listings, est_total: salvage.total_est }),
      created_at: new Date().toISOString(),
    });

  } catch(e) {
    console.error("[salvage] error:", e.message);
  }
}

module.exports = { processSalvage, estimateSalvageValue };
