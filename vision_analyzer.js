const fetch = require("node-fetch");
const { normalizeVisionPayload } = require("./vision_buckets");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing env: " + name);
  return v;
}

async function fetchImageAsBase64(url) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const auth = Buffer.from(accountSid + ":" + authToken).toString("base64");

  const res = await fetch(url, {
    headers: { "Authorization": "Basic " + auth }
  });

  if (!res.ok) throw new Error("Failed to fetch image: " + res.status);

  const buffer = await res.buffer();
  const contentType = res.headers.get("content-type") || "image/jpeg";
  return { base64: buffer.toString("base64"), mediaType: contentType.split(";")[0] };
}

async function analyzeJobMedia(mediaUrl) {
  const apiKey = must("ANTHROPIC_API_KEY");

  let imageData;
  try {
    imageData = await fetchImageAsBase64(mediaUrl);
  } catch (e) {
    throw new Error("Could not fetch media: " + e.message);
  }

  const prompt = `You are analyzing a photo for ICL Junk Removal, a junk removal company in Los Angeles.

ICL operates with military precision and deep respect for every client. Your analysis helps the crew walk in prepared — knowing what to expect, what to protect, and what has value.

Analyze this image and respond ONLY with a JSON object in this exact format:
{
  "is_valid_junk": true or false,
  "troll_flag": true or false,
  "troll_reason": "reason if troll_flag is true, otherwise null",
  "load_bucket": "MIN" or "QTR" or "HALF" or "3Q" or "FULL",
  "load_confidence": "HIGH" or "MEDIUM" or "LOW",
  "access_level": "CURB" or "DRIVEWAY" or "GARAGE" or "INSIDE_HOME" or "STAIRS" or "APARTMENT" or "UNKNOWN",
  "access_confidence": "HIGH" or "MEDIUM" or "LOW",
  "items": ["specific", "visible", "items", "with", "descriptors"],
  "resell_items": ["items likely worth reselling"],
  "scrap_items": ["items likely paid as scrap metal"],
  "donate_items": ["items likely suitable for donation"],
  "dump_items": ["items likely landfill/trash"],
  "classified_items": [
    { "item": "string", "bucket": "RESELL or SCRAP or DONATE or DUMP", "confidence": 0.0 to 1.0 }
  ],
  "bucket_confidence": { "resell": 0.0 to 1.0, "scrap": 0.0 to 1.0, "donate": 0.0 to 1.0, "dump": 0.0 to 1.0 },
  "resell_notes": "brief note on resell potential, or null if none",
  "sentimental_risk": true or false,
  "sentimental_notes": "note if photos, religious items, personal keepsakes visible — crew should handle with care, or null",
  "crew_notes": "2-3 sentences: space condition, access challenges, heavy items, sequencing advice",
  "space_type": "garage" or "bedroom" or "living_room" or "yard" or "storage_unit" or "basement" or "office" or "kitchen" or "other",
  "data_tags": ["furniture", "appliances", "electronics", "construction", "yard_waste", "mattress", "clothing", "boxes", "mixed", "other"]
}

Load bucket guide:
- MIN ($150): single item or small pile, fits in pickup truck bed
- QTR ($450): small load, quarter of a truck
- HALF ($850): medium load, half a truck
- 3Q ($1200): large load, three quarters of a truck
- FULL ($1500): full truckload, entire space packed

Resell guide — flag these if they appear to be in decent condition:
- Furniture: couches, sofas, chairs, dressers, tables, desks, bookshelves, cabinets
- Appliances: refrigerators, washers, dryers, microwaves, fans, AC units
- Electronics: TVs, monitors, speakers, computers
- Equipment: bikes, treadmills, tools, ladders, dollies
- Decor: lamps, mirrors, artwork, shelving

Scrap guide:
- Metals and wire: copper, aluminum, steel, brass, cast iron, piping, appliance shells

Donate guide:
- Household goods and usable items: clothes, books, toys, kitchenware, small furniture in good condition

Dump guide:
- Broken, contaminated, heavily worn, non-recoverable items

troll_flag should be true if: image is clearly not junk (selfie, meme, random street photo, explicit content)
is_valid_junk should be false ONLY if the image is clearly not junk-related (selfie, meme, blank wall, street scene). If ANY household item, furniture, appliance, or debris is visible — even if it looks like it could stay — set is_valid_junk to true. When in doubt, set true.
sentimental_risk should be true if you see: photo albums, framed family photos, religious items, children's items, urns, personal documents.

Respond with ONLY the JSON object, no other text.`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-opus-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: imageData.mediaType,
                data: imageData.base64
              }
            },
            {
              type: "text",
              text: prompt
            }
          ]
        }
      ]
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error("Anthropic API error: " + JSON.stringify(data.error || data));
  }

  const text = data.content[0].text.trim();

  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return normalizeVisionPayload(JSON.parse(clean));
  } catch (e) {
    throw new Error("Could not parse vision response: " + text);
  }
}


// Analyze multiple photos and merge results
async function analyzeAllMedia(urls) {
  if (!urls || urls.length === 0) throw new Error("No media URLs");
  if (urls.length === 1) return analyzeJobMedia(urls[0]);

  // Analyze each photo in parallel
  const results = await Promise.allSettled(urls.map(u => analyzeJobMedia(u)));
  const valid = results
    .filter(r => r.status === "fulfilled" && r.value?.is_valid_junk)
    .map(r => r.value);

  if (valid.length === 0) return results[0].value || results[0].reason;

  // Merge: take highest load_bucket, merge item buckets, merge notes
  const LOAD_ORDER = ["MIN","QTR","HALF","3Q","FULL"];
  let merged = normalizeVisionPayload(valid[0]);
  const mergeUnique = (base, extra, limit = 40) => {
    const out = [];
    const seen = new Set();
    const src = [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])];
    for (const raw of src) {
      const item = String(raw || "").trim();
      if (!item) continue;
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  };

  for (const v of valid.slice(1)) {
    const norm = normalizeVisionPayload(v);
    // Take larger load estimate
    const curIdx = LOAD_ORDER.indexOf(merged.load_bucket);
    const newIdx = LOAD_ORDER.indexOf(norm.load_bucket);
    if (newIdx > curIdx) {
      merged.load_bucket = norm.load_bucket;
      merged.load_confidence = norm.load_confidence;
    }
    merged.items = mergeUnique(merged.items, norm.items);
    merged.resell_items = mergeUnique(merged.resell_items, norm.resell_items);
    merged.scrap_items = mergeUnique(merged.scrap_items, norm.scrap_items);
    merged.donate_items = mergeUnique(merged.donate_items, norm.donate_items);
    merged.dump_items = mergeUnique(merged.dump_items, norm.dump_items);
    merged.classified_items = mergeUnique(
      (merged.classified_items || []).map((r) => `${r.bucket}:${r.item}`),
      (norm.classified_items || []).map((r) => `${r.bucket}:${r.item}`)
    ).map((k) => {
      const [bucket, ...rest] = String(k || "").split(":");
      return { bucket, item: rest.join(":").trim(), confidence: merged.bucket_confidence?.[String(bucket || "").toLowerCase()] || 0.58 };
    });
    merged.bucket_confidence = {
      resell: Math.max(Number(merged.bucket_confidence?.resell || 0), Number(norm.bucket_confidence?.resell || 0)),
      scrap: Math.max(Number(merged.bucket_confidence?.scrap || 0), Number(norm.bucket_confidence?.scrap || 0)),
      donate: Math.max(Number(merged.bucket_confidence?.donate || 0), Number(norm.bucket_confidence?.donate || 0)),
      dump: Math.max(Number(merged.bucket_confidence?.dump || 0), Number(norm.bucket_confidence?.dump || 0))
    };
    // Append crew notes
    if (norm.crew_notes && norm.crew_notes !== merged.crew_notes) {
      merged.crew_notes = (merged.crew_notes || "") + " " + norm.crew_notes;
    }
    // If any photo flags troll, flag it
    if (norm.troll_flag) merged.troll_flag = true;
    // Take more specific access level
    if (norm.access_confidence === "HIGH" && merged.access_confidence !== "HIGH") {
      merged.access_level = norm.access_level;
      merged.access_confidence = norm.access_confidence;
    }
  }

  merged.photo_count = urls.length;
  return normalizeVisionPayload(merged);
}

module.exports = { analyzeJobMedia, analyzeAllMedia };
