// job_complete.js - handles DONE reply from ops, collects diversion data
const { pool, insertEvent } = require("./db");
const { sendSms } = require("./twilio_sms");

const OPS_PHONE = "+12138806318";
const CREW_ITEM_COMMANDS = new Set(["RESELL", "SCRAP", "DONATE", "DUMP", "PLATES"]);

function centsFromMaybeDollars(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function normalizeOpsPhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length < 10) return null;
  return "+" + d;
}

function parseCrewItemInput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const firstSpace = trimmed.indexOf(" ");
  const command = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).trim().toUpperCase();
  if (!CREW_ITEM_COMMANDS.has(command)) return null;

  let rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  if (!rest) return { command, phone: null, itemText: "" };

  // Optional explicit lead phone prefix, then item text.
  const m = rest.match(/^(\+?[\d\-\(\)\s]{10,})\s+(.+)$/);
  if (m) {
    const maybePhone = normalizeOpsPhone(m[1]);
    if (maybePhone) return { command, phone: maybePhone, itemText: m[2].trim() };
  }
  return { command, phone: null, itemText: rest };
}

function mapCommandToBucket(command) {
  if (command === "PLATES") return "RESELL";
  return command;
}

async function resolveLeadForOps(phoneHint) {
  if (phoneHint) {
    const exact = await pool.query("SELECT * FROM leads WHERE from_phone = $1 LIMIT 1", [phoneHint]);
    if (exact.rows[0]) return exact.rows[0];

    const digits = phoneHint.replace(/\D/g, "");
    if (digits.length >= 10) {
      const fallback = await pool.query(
        `SELECT *
         FROM leads
         WHERE regexp_replace(from_phone, '\\D', '', 'g') LIKE '%' || $1
         ORDER BY last_seen_at DESC
         LIMIT 1`,
        [digits.slice(-10)]
      );
      if (fallback.rows[0]) return fallback.rows[0];
    }
  }

  const recent = await pool.query(
    `SELECT *
     FROM leads
     WHERE quote_status IN ('DEPOSIT_PAID','BOOKING_SENT','WINDOW_SELECTED','COMPLETED')
     ORDER BY COALESCE(deposit_paid_at, last_seen_at) DESC
     LIMIT 1`
  );
  if (recent.rows[0]) return recent.rows[0];

  const any = await pool.query("SELECT * FROM leads ORDER BY last_seen_at DESC LIMIT 1");
  return any.rows[0] || null;
}

async function maybeLogCrewItem(body) {
  const parsed = parseCrewItemInput(body);
  if (!parsed) return null;
  if (!parsed.itemText) {
    await sendSms(
      OPS_PHONE,
      "Missing item description. Example: RESELL black metal rack or SCRAP mixed metal pile."
    );
    return { type: "crew_item_missing_description" };
  }

  const lead = await resolveLeadForOps(parsed.phone);
  if (!lead) {
    await sendSms(OPS_PHONE, "No lead found to attach this item log. Include customer phone after command.");
    return { type: "crew_item_no_lead" };
  }

  const bucket = mapCommandToBucket(parsed.command);
  const itemName = parsed.itemText.slice(0, 180);
  const nowIso = new Date().toISOString();
  const jobId = `${lead.from_phone}:${String(lead.deposit_paid_at || lead.last_seen_at || nowIso).slice(0, 10)}`;
  let estLow = null;
  let estHigh = null;
  let platform = null;
  if (bucket === "RESELL") {
    platform = "Facebook Marketplace";
    if (parsed.command === "PLATES") {
      estLow = centsFromMaybeDollars(150);
      estHigh = centsFromMaybeDollars(400);
    }
  }

  await pool.query(
    `INSERT INTO job_items
      (job_id, from_phone, item_name, bucket, est_value_low, est_value_high, confidence, platform, crew_notes, status, source, created_at)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [jobId, lead.from_phone, itemName, bucket, estLow, estHigh, null, platform, null, "LOGGED", "crew_sms", nowIso]
  );

  insertEvent.run({
    from_phone: lead.from_phone,
    event_type: "crew_item_logged",
    payload_json: JSON.stringify({
      job_id: jobId,
      command: parsed.command,
      bucket,
      item_name: itemName,
      source: "crew_sms"
    }),
    created_at: nowIso
  });

  if (bucket === "RESELL") {
    insertEvent.run({
      from_phone: lead.from_phone,
      event_type: "resell_followup_needed",
      payload_json: JSON.stringify({ item_name: itemName, job_id: jobId }),
      created_at: nowIso
    });
  }

  await sendSms(
    OPS_PHONE,
    `✅ Logged ${bucket}: "${itemName}"\nLead: ${lead.from_phone}\nJob: ${jobId}`
  );
  return { type: "crew_item_logged", bucket, item: itemName, from_phone: lead.from_phone, job_id: jobId };
}

async function handleOpsReply(body) {
  const raw = String(body || "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();

  const crewItem = await maybeLogCrewItem(raw);
  if (crewItem) return crewItem;

  // DONE [address or phone] — mark job complete, ask for diversion data
  if (upper.startsWith("DONE")) {
    const identifier = raw.slice(4).trim();
    await sendSms(OPS_PHONE,
      `✅ Got it! Quick debrief:\n\nReply with:\nDIVERT [donated items] | [scrap items] | [dump lbs] | [junk fee $]\n\nExample:\nDIVERT couch,dresser | washer | 200 | 45\n\nOr DIVERT NONE if everything went to dump.`
    );
    return { type: "done_ack", identifier };
  }

  // DIVERT [donated] | [scrap] | [dump_lbs] | [fee]
  if (upper.startsWith("DIVERT")) {
    const data = raw.slice(6).trim();

    if (data.toUpperCase() === "NONE") {
      await sendSms(OPS_PHONE, "📊 Logged. All to dump. We'll track diversion rate over time.");
      return { type: "divert_none" };
    }

    const parts = data.split("|").map(p => p.trim());
    const donated = parts[0] || "";
    const scrap = parts[1] || "";
    const dumpLbs = parseInt(parts[2]) || 0;
    const junkFee = parseInt(parts[3]) || 0;

    const totalItems = (donated ? donated.split(",").length : 0) + (scrap ? scrap.split(",").length : 0);
    const totalWeight = dumpLbs + (totalItems * 30); // estimate 30lbs per diverted item
    const diversionRate = totalWeight > 0 ? Math.round((totalItems * 30) / totalWeight * 100) : 0;

    // Find most recent completed lead for ops
    const result = await pool.query(`
      SELECT from_phone FROM leads
      WHERE quote_status IN ('DEPOSIT_PAID','BOOKING_SENT','WINDOW_SELECTED')
      ORDER BY deposit_paid_at DESC LIMIT 1
    `);

    if (result.rows.length > 0) {
      const from_phone = result.rows[0].from_phone;
      await pool.query(`
        UPDATE leads SET
          diversion_donated_items=$1,
          diversion_scrap_items=$2,
          diversion_dump_weight_lbs=$3,
          diversion_rate=$4,
          junk_fee_actual=$5,
          quote_status='COMPLETED'
        WHERE from_phone=$6
      `, [donated, scrap, dumpLbs, diversionRate, junkFee * 100, from_phone]);

      insertEvent.run({
        from_phone,
        event_type: "job_completed",
        payload_json: JSON.stringify({ donated, scrap, dumpLbs, junkFee, diversionRate }),
        created_at: new Date().toISOString(),
      });
    }

    const savings = Math.max(0, 360 - junkFee);
    await sendSms(OPS_PHONE,
      `📊 Job logged!\n` +
      `♻️ Donated: ${donated || "none"}\n` +
      `🔩 Scrap: ${scrap || "none"}\n` +
      `🗑️ Dump: ${dumpLbs}lbs @ $${junkFee}\n` +
      `📈 Diversion rate: ${diversionRate}%\n` +
      `💰 Saved vs baseline: $${savings}`
    );

    return { type: "divert_logged", diversionRate, savings };
  }

  // SOLD [item] $[price] — log salvage sale
  if (upper.startsWith("SOLD")) {
    const parts = raw.slice(4).trim().split("$");
    const item = parts[0].trim();
    const price = parseInt(parts[1]) || 0;

    // Find most recent lead
    const result = await pool.query(`
      SELECT from_phone FROM leads
      ORDER BY last_seen_at DESC LIMIT 1
    `);

    if (result.rows.length > 0 && price > 0) {
      const from_phone = result.rows[0].from_phone;
      await pool.query(
        "UPDATE leads SET salvage_actual_value=COALESCE(salvage_actual_value,0)+$1 WHERE from_phone=$2",
        [price * 100, from_phone]
      );
      insertEvent.run({
        from_phone,
        event_type: "salvage_sold",
        payload_json: JSON.stringify({ item, price }),
        created_at: new Date().toISOString(),
      });
    }

    await sendSms(OPS_PHONE, `💵 Logged: ${item} sold for $${price}. Nice work.`);
    return { type: "salvage_logged", item, price };
  }

  return null;
}

module.exports = { handleOpsReply };
