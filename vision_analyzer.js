const fetch = require("node-fetch");

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
  "resell_items": ["items likely worth reselling or donating — furniture, appliances, bikes, tools, electronics in good condition"],
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

troll_flag should be true if: image is clearly not junk (selfie, meme, random street photo, explicit content)
is_valid_junk should be false if you cannot identify any items that need removal.
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
      model: "claude-opus-4-6",
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
    return JSON.parse(clean);
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

  // Merge: take highest load_bucket, merge items, merge crew_notes
  const LOAD_ORDER = ["MIN","QTR","HALF","3Q","FULL"];
  let merged = { ...valid[0] };

  for (const v of valid.slice(1)) {
    // Take larger load estimate
    const curIdx = LOAD_ORDER.indexOf(merged.load_bucket);
    const newIdx = LOAD_ORDER.indexOf(v.load_bucket);
    if (newIdx > curIdx) {
      merged.load_bucket = v.load_bucket;
      merged.load_confidence = v.load_confidence;
    }
    // Merge items (deduplicate)
    const allItems = [...(merged.items||[]), ...(v.items||[])];
    merged.items = [...new Set(allItems)];
    // Append crew notes
    if (v.crew_notes && v.crew_notes !== merged.crew_notes) {
      merged.crew_notes = (merged.crew_notes || "") + " " + v.crew_notes;
    }
    // If any photo flags troll, flag it
    if (v.troll_flag) merged.troll_flag = true;
    // Take more specific access level
    if (v.access_confidence === "HIGH" && merged.access_confidence !== "HIGH") {
      merged.access_level = v.access_level;
      merged.access_confidence = v.access_confidence;
    }
  }

  merged.photo_count = urls.length;
  return merged;
}

module.exports = { analyzeJobMedia, analyzeAllMedia };
