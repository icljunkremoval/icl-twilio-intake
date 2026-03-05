// crew_brief.js - generates and sends crew briefing to Ops Lead on deposit paid
const { sendSms } = require("./twilio_sms");
const { pool } = require("./db");

const OPS_PHONE = "+12138806318";

const LOAD_LABELS = {
  MIN:  "Minimal — pickup truck bed",
  QTR:  "Quarter truck",
  HALF: "Half truck",
  "3Q": "Three quarter truck",
  FULL: "Full truck",
};

const ACCESS_LABELS = {
  CURB:       "Curbside — easy load",
  DRIVEWAY:   "Driveway access",
  GARAGE:     "Garage — check clearance",
  INSIDE_HOME:"Inside home — carry out required",
  INSIDE:     "Inside home — carry out required",
  STAIRS:     "Stairs involved — plan lifts carefully",
  APARTMENT:  "Apartment — elevator or stairs?",
  OTHER:      "Non-standard access — assess on arrival",
};

const SPACE_LABELS = {
  garage:       "Garage",
  bedroom:      "Bedroom",
  living_room:  "Living room",
  yard:         "Yard / outdoor",
  storage_unit: "Storage unit",
  basement:     "Basement",
  office:       "Office space",
  kitchen:      "Kitchen",
  other:        "Mixed space",
};

function parseVision(vision_analysis) {
  try {
    return typeof vision_analysis === "string"
      ? JSON.parse(vision_analysis)
      : (vision_analysis || {});
  } catch { return {}; }
}

async function getEventCount(from_phone) {
  try {
    const r = await pool.query("SELECT COUNT(*) as cnt FROM events WHERE from_phone=$1", [from_phone]);
    return parseInt(r.rows[0].cnt) || 0;
  } catch { return 0; }
}

function buildCrewBrief(lead, eventCount) {
  const v = parseVision(lead.vision_analysis);
  const items = v.items || [];
  const resellItems = v.resell_items || [];
  const loadLabel = LOAD_LABELS[lead.load_bucket] || lead.load_bucket || "Unknown";
  const accessLabel = ACCESS_LABELS[lead.access_level] || lead.access_level || "Unknown";
  const spaceLabel = SPACE_LABELS[v.space_type] || "Unknown space";
  const window = lead.timing_pref || "TBD";
  const isRepeat = eventCount > 15;
  const responseSpeed = eventCount < 8 ? "Quick responder" : "Took their time";

  const lines = [
    "🚛 ICL JOB BRIEF",
    "─────────────────",
    `📍 ${lead.address_text || "Address pending"}`,
    `📞 ${lead.from_phone}`,
    `🕐 Window: ${window}`,
    "",
    "THE SPACE:",
    `${spaceLabel} • ${loadLabel}`,
    `Access: ${accessLabel}`,
  ];

  if (items.length > 0) {
    lines.push("");
    lines.push("WHAT'S THERE:");
    items.slice(0, 6).forEach(item => lines.push(`  • ${item}`));
    if (items.length > 6) lines.push(`  • ...+${items.length - 6} more`);
  }

  if (resellItems.length > 0) {
    lines.push("");
    lines.push("♻️ WORTH A LOOK:");
    resellItems.slice(0, 4).forEach(item => lines.push(`  • ${item}`));
    if (v.resell_notes) lines.push(`  ${v.resell_notes}`);
  }

  if (v.sentimental_risk) {
    lines.push("");
    lines.push("💛 HANDLE WITH CARE:");
    lines.push(`  ${v.sentimental_notes || "Personal items spotted — check with client before removing"}`);
  }

  if (v.crew_notes) {
    lines.push("");
    lines.push("📋 CREW NOTES:");
    const sentences = v.crew_notes.split(/[.!?]+/).filter(s => s.trim().length > 10);
    lines.push(sentences.slice(0, 2).join(". ").trim() + ".");
  }

  lines.push("");
  lines.push("👤 THE CLIENT:");
  lines.push(`  ${isRepeat ? "Return customer" : "First-time client"} • ${responseSpeed}`);
  if (lead.troll_flag) lines.push("  ⚠️ Verify job on arrival");

  lines.push("");
  lines.push("─────────────────");
  lines.push("Humble. Hungry. People Smart.");
  lines.push("Reply DONE when complete.");

  return lines.join("\n");
}

async function sendCrewBrief(lead) {
  try {
    const eventCount = await getEventCount(lead.from_phone);
    const brief = buildCrewBrief(lead, eventCount);
    const sms = await sendSms(OPS_PHONE, brief);
    console.log("[crew_brief] sent for", lead.from_phone);
    return sms;
  } catch(e) {
    console.error("[crew_brief] error:", e.message);
  }
}

module.exports = { sendCrewBrief, buildCrewBrief };
