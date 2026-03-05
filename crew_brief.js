// crew_brief.js - generates and sends crew briefing to Ops Lead on deposit paid
const { sendSms } = require("./twilio_sms");

const OPS_PHONE = "+12138806318";

const LOAD_LABELS = {
  MIN: "Minimal — pickup truck bed",
  QTR: "Quarter truck",
  HALF: "Half truck",
  "3Q": "Three quarter truck",
  FULL: "Full truck",
};

const ACCESS_LABELS = {
  CURB: "Curbside pickup",
  DRIVEWAY: "Driveway access",
  GARAGE: "Garage — may be tight",
  INSIDE: "Inside home — carry out required",
  STAIRS: "Stairs involved",
  APARTMENT: "Apartment building",
  OTHER: "Non-standard access",
};

function parseItems(vision_analysis) {
  try {
    const v = typeof vision_analysis === "string"
      ? JSON.parse(vision_analysis)
      : vision_analysis;
    return v?.items || [];
  } catch { return []; }
}

function parseCrewNotes(vision_analysis) {
  try {
    const v = typeof vision_analysis === "string"
      ? JSON.parse(vision_analysis)
      : vision_analysis;
    return v?.crew_notes || null;
  } catch { return null; }
}

function flagResellItems(items) {
  const RESELL_KEYWORDS = [
    "couch", "sofa", "chair", "dresser", "table", "desk", "bookshelf",
    "appliance", "refrigerator", "washer", "dryer", "microwave", "tv",
    "television", "bike", "bicycle", "treadmill", "furniture", "cabinet",
    "mattress", "bed frame", "lamp", "mirror"
  ];
  return items.filter(item =>
    RESELL_KEYWORDS.some(kw => item.toLowerCase().includes(kw))
  );
}

function buildCrewBrief(lead) {
  const items = parseItems(lead.vision_analysis);
  const crewNotes = parseCrewNotes(lead.vision_analysis);
  const resellItems = flagResellItems(items);

  const loadLabel = LOAD_LABELS[lead.load_bucket] || lead.load_bucket || "Unknown";
  const accessLabel = ACCESS_LABELS[lead.access_level] || lead.access_level || "Unknown";
  const window = lead.timing_pref || "Not yet selected";

  // Get customer name from Square billing if available
  const lines = [
    "🚛 ICL JOB BRIEF",
    "─────────────────",
    `📍 ${lead.address_text || "Address not provided"}`,
    `📞 ${lead.from_phone}`,
    `🕐 Window: ${window}`,
    "",
    `📦 Load: ${loadLabel}`,
    `🚪 Access: ${accessLabel}`,
  ];

  if (items.length > 0) {
    lines.push("");
    lines.push("🏷️ Items spotted:");
    items.slice(0, 6).forEach(item => lines.push(`  • ${item}`));
  }

  if (resellItems.length > 0) {
    lines.push("");
    lines.push("♻️ Possible resell:");
    resellItems.forEach(item => lines.push(`  • ${item}`));
  }

  if (crewNotes) {
    lines.push("");
    lines.push("📋 Notes:");
    // Keep crew notes concise — first 2 sentences
    const sentences = crewNotes.split(/[.!?]+/).filter(s => s.trim().length > 10);
    lines.push(sentences.slice(0, 2).join(". ").trim() + ".");
  }

  if (lead.troll_flag) {
    lines.push("");
    lines.push("⚠️ VERIFY JOB — flagged by vision AI");
  }

  lines.push("");
  lines.push("─────────────────");
  lines.push("Reply DONE when job complete.");

  return lines.join("\n");
}

async function sendCrewBrief(lead) {
  try {
    const brief = buildCrewBrief(lead);
    const sms = await sendSms(OPS_PHONE, brief);
    console.log("[crew_brief] sent for", lead.from_phone);
    return sms;
  } catch(e) {
    console.error("[crew_brief] error:", e.message);
  }
}

module.exports = { sendCrewBrief, buildCrewBrief };
