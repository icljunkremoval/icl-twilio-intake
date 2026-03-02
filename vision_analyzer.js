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

Analyze this image and respond ONLY with a JSON object in this exact format:
{
  "is_valid_junk": true or false,
  "troll_flag": true or false,
  "troll_reason": "reason if troll_flag is true, otherwise null",
  "load_bucket": "MIN" or "QTR" or "HALF" or "3Q" or "FULL",
  "load_confidence": "HIGH" or "MEDIUM" or "LOW",
  "access_level": "CURB" or "DRIVEWAY" or "GARAGE" or "INSIDE_HOME" or "STAIRS" or "APARTMENT" or "UNKNOWN",
  "access_confidence": "HIGH" or "MEDIUM" or "LOW",
  "items": ["list", "of", "visible", "items"],
  "crew_notes": "brief notes to help the crew prepare - hazards, heavy items, tight spaces, etc.",
  "data_tags": ["furniture", "appliances", "electronics", "construction", "yard_waste", "mattress", "clothing", "boxes", "mixed", "other"]
}

Load bucket guide:
- MIN ($150): single item or small pile, fits in pickup truck bed
- QTR ($450): small load, quarter of a truck
- HALF ($850): medium load, half a truck
- 3Q ($1200): large load, three quarters of a truck  
- FULL ($1500): full truckload, entire space packed

troll_flag should be true if: the image is clearly not junk (random street photo, selfie, meme, explicit content, etc.)
is_valid_junk should be false if you cannot identify any items that need removal.

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

module.exports = { analyzeJobMedia };
