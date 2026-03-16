const { checkDropoffs } = require("./dropoff_monitor");
const { handleOpsReply } = require("./job_complete");
const { handleSquareWebhook } = require("./square_webhook");
const { fetchLatest } = require("./twilio_debug");
const { backfillLatestMedia } = require("./twilio_media_backfill");
const { recomputeDerived } = require("./recompute");
const { handleWindowReply } = require("./window_reply");
const { evaluateQuoteReadyRow } = require("./quote_gate");
const { handleConversation } = require("./conversation");
const { listWorldviewLeads } = require("./worldview_intel");
const { parseBookingToken } = require("./booking_link");
const { createJobEvent } = require("./calendar");
const { sendSms } = require("./twilio_sms");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { db, pool, upsertLead, insertEvent, getLead } = require("./db");
const fetch = (...args) => import("node-fetch").then(({default: f}) => f(...args));

const BASE_LOCATION = "506 E Brett St, Inglewood, CA 90301";

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function geocodeOSM(q) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", q);
  const r = await fetch(url.toString(), { headers: { "User-Agent": "ICL-Twilio-Intake/1.0" }});
  const j = await r.json();
  if (!Array.isArray(j) || j.length === 0) return null;
  return { lat: Number(j[0].lat), lon: Number(j[0].lon), display: j[0].display_name };
}

const app = express();
app.use("/public", require("express").static(require("path").join(__dirname, "public")));
app.use(express.json({ limit: "2mb" }))
// Territory dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
;
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
app.use("/admin", (req, res, next) => {
  if (!ADMIN_PASSWORD) return res.status(500).send("Admin password not set.");
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="ICL Admin"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
  const pass = decoded.split(":").slice(1).join(":");
  if (pass !== ADMIN_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="ICL Admin"');
    return res.status(401).send("Bad credentials");
  }
  next();
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 8788;
const BASE_DIR = path.join(process.env.HOME || ".", "secrets", "twilio-intake-logs");
const LEADS_DIR = path.join(BASE_DIR, "leads");
fs.mkdirSync(BASE_DIR, { recursive: true });
fs.mkdirSync(LEADS_DIR, { recursive: true });
const BOOKING_WINDOWS = ["8-10am", "10-12pm", "12-2pm", "2-4pm", "4-6pm"];

let baseGeo = null;

function safeFilenameFromPhone(phone) {
  return String(phone || "unknown").replace(/[^0-9+]/g, "_");
}

function upsertLeadFile(from, patch) {
  const fn = safeFilenameFromPhone(from) + ".json";
  const fp = path.join(LEADS_DIR, fn);
  let cur = {};
  if (fs.existsSync(fp)) {
    try { cur = JSON.parse(fs.readFileSync(fp, "utf8")); } catch {}
  }
  const next = {
    ...cur,
    ...patch,
    _meta: { ...(cur._meta || {}), updatedAt: new Date().toISOString(), from },
  };
  fs.writeFileSync(fp, JSON.stringify(next, null, 2), { mode: 0o600 });
  return fp;
}

function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayLabelFromIso(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (!Number.isFinite(dt.getTime())) return null;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][dt.getUTCMonth()];
  return `${dow} ${mon} ${dt.getUTCDate()}`;
}

function bookingDayOptions(days = 7) {
  const now = new Date();
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const iso = toIsoDate(d);
    const label = dayLabelFromIso(iso);
    if (!label) continue;
    out.push({ iso, label });
  }
  return out;
}

async function latestPaymentMetaForPhone(fromPhone) {
  try {
    const row = (
      await pool.query(
        `SELECT event_type, payload_json, created_at
         FROM events
         WHERE from_phone = $1
           AND event_type IN ('deposit_paid', 'upfront_paid')
         ORDER BY id DESC
         LIMIT 1`,
        [fromPhone]
      )
    ).rows[0];
    if (!row) return null;
    let payload = {};
    try { payload = JSON.parse(row.payload_json || "{}"); } catch {}
    return {
      event_type: row.event_type,
      confirmation_id: payload.confirmation_id || null,
      booking_link: payload.booking_link || null,
      created_at: row.created_at || null
    };
  } catch {
    return null;
  }
}

app.post("/square/webhook", handleSquareWebhook);
// Ops reply handler — intercepts texts from business number
app.post("/twilio/ops-reply", async (req, res) => {
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
  try {
    const body = req.body.Body || "";
    await handleOpsReply(body);
  } catch(e) {
    console.error("[ops_reply]", e.message);
  }
});

app.get("/api/worldview/leads", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 80);
    const leads = await listWorldviewLeads({ limit });
    return res.json({ ok: true, leads, generated_at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/worldview/lead/:from", async (req, res) => {
  try {
    const from = String(req.params.from || "");
    if (!from) return res.status(400).json({ ok: false, error: "missing from" });
    const leads = await listWorldviewLeads({ limit: 200 });
    const lead = leads.find((l) => String(l.phone) === from);
    if (!lead) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true, lead, generated_at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/booking/:token", async (req, res) => {
  try {
    const parsed = parseBookingToken(req.params.token, { maxAgeDays: 30 });
    if (!parsed.ok) return res.status(400).send("Booking link expired. Reply to our SMS for a new link.");
    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone = $1 LIMIT 1", [parsed.phone])).rows[0];
    if (!lead) return res.status(404).send("Lead not found.");
    const paymentMeta = await latestPaymentMetaForPhone(parsed.phone);
    const days = bookingDayOptions(7);
    const dayOptions = days.map((d) => `<option value="${escHtml(d.iso)}">${escHtml(d.label)}</option>`).join("");
    const windowOptions = BOOKING_WINDOWS.map((w) => `<option value="${escHtml(w)}">${escHtml(w)}</option>`).join("");
    const confirmation = paymentMeta?.confirmation_id
      ? `<div class="pill">Confirmation #: <strong>${escHtml(paymentMeta.confirmation_id)}</strong></div>`
      : "";

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ICL Booking</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;padding:18px;color:#0f172a}
    .card{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;box-shadow:0 8px 26px rgba(2,6,23,.08)}
    .hero{background:linear-gradient(135deg,#0f766e,#134e4a);padding:18px 20px;color:#f0fdfa}
    .brand{font-size:13px;opacity:.9;letter-spacing:.4px;text-transform:uppercase}
    h1{margin:6px 0 4px;font-size:24px;line-height:1.2}
    .hero p{margin:0;color:#ccfbf1}
    .body{padding:18px 20px}
    p{margin:8px 0;color:#334155}
    .steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0 12px}
    .st{font-size:11px;border:1px solid #cbd5e1;border-radius:999px;padding:6px 8px;text-align:center;background:#fff;color:#334155}
    .st.on{background:#dcfce7;border-color:#16a34a;color:#166534;font-weight:700}
    .st.next{background:#ecfeff;border-color:#22d3ee;color:#155e75;font-weight:600}
    .pill{display:inline-block;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:999px;padding:5px 10px;font-size:12px;color:#334155;margin:6px 0}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0 2px}
    .meta .m{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;font-size:13px}
    label{display:block;margin:12px 0 4px;font-size:13px;color:#334155;font-weight:600}
    select,button{width:100%;padding:12px;border-radius:10px;border:1px solid #cbd5e1;font-size:15px}
    button{background:#0f766e;color:#fff;border:none;font-weight:700;cursor:pointer;margin-top:14px}
    button:disabled{opacity:.6;cursor:not-allowed}
    .ok{margin-top:12px;color:#065f46;font-weight:700}
    .err{margin-top:12px;color:#b91c1c;font-weight:600}
    .small{font-size:12px;color:#64748b}
    .foot{margin-top:12px;padding-top:10px;border-top:1px solid #e2e8f0}
    @media(max-width:720px){.steps{grid-template-columns:1fr 1fr}.meta{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="card">
    <div class="hero">
      <div class="brand">ICL Junk Removal</div>
      <h1>Choose Your Arrival Window</h1>
      <p>You’re confirmed. This is the final step to lock your schedule.</p>
    </div>
    <div class="body">
      ${confirmation}
      <div class="steps">
        <div class="st on">Paid</div>
        <div class="st next">Schedule</div>
        <div class="st">Removed</div>
        <div class="st">Complete</div>
      </div>
      <div class="meta">
        <div class="m"><strong>Phone</strong><br>${escHtml(parsed.phone)}</div>
        <div class="m"><strong>Address</strong><br>${escHtml(lead.address_text || "On file")}</div>
      </div>
      <p class="small">You should have received your Square receipt. Pick a day + window below.</p>
      <form id="book-form">
        <input type="hidden" name="token" value="${escHtml(req.params.token)}" />
        <label for="day_iso">Day</label>
        <select id="day_iso" name="day_iso" required>${dayOptions}</select>
        <label for="window">Arrival window</label>
        <select id="window" name="window" required>${windowOptions}</select>
        <button id="book-btn" type="submit">Confirm my appointment</button>
        <div id="book-msg"></div>
      </form>
      <div class="foot">
        <p class="small">Need help? Reply HELP to our text and we’ll assist.</p>
      </div>
    </div>
  </div>
  <script>
    const form=document.getElementById('book-form');
    const msg=document.getElementById('book-msg');
    const btn=document.getElementById('book-btn');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.className=''; msg.textContent='';
      btn.disabled=true;
      try{
        const payload={
          token: form.token.value,
          day_iso: form.day_iso.value,
          window: form.window.value
        };
        const r=await fetch('/api/booking/confirm',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify(payload)
        });
        const j=await r.json();
        if(!j.ok){throw new Error(j.error||'Could not schedule');}
        msg.className='ok';
        msg.textContent='Booked! We also sent confirmation by SMS.';
      }catch(err){
        msg.className='err';
        msg.textContent=String(err.message||err);
      }finally{
        btn.disabled=false;
      }
    });
  </script>
</body>
</html>`);
  } catch (e) {
    return res.status(500).send(String(e?.message || e));
  }
});

app.post("/api/booking/confirm", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const dayIso = String(req.body?.day_iso || "").trim();
    const window = String(req.body?.window || "").trim();
    if (!token || !dayIso || !window) return res.status(400).json({ ok: false, error: "missing_fields" });
    if (!BOOKING_WINDOWS.includes(window)) return res.status(400).json({ ok: false, error: "invalid_window" });

    const parsed = parseBookingToken(token, { maxAgeDays: 30 });
    if (!parsed.ok) return res.status(400).json({ ok: false, error: "expired_link" });

    const dayLabel = dayLabelFromIso(dayIso);
    if (!dayLabel) return res.status(400).json({ ok: false, error: "invalid_day" });
    const timingPref = `${dayLabel}, ${window}`;

    await pool.query(
      `UPDATE leads
       SET timing_pref = $1,
           conv_state = 'WINDOW_SELECTED',
           quote_status = 'WINDOW_SELECTED',
           last_seen_at = NOW()
       WHERE from_phone = $2`,
      [timingPref, parsed.phone]
    );

    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone = $1 LIMIT 1", [parsed.phone])).rows[0];
    if (!lead) return res.status(404).json({ ok: false, error: "lead_not_found" });

    insertEvent.run({
      from_phone: parsed.phone,
      event_type: "booking_link_scheduled",
      payload_json: JSON.stringify({ timing_pref: timingPref, source: "booking_link" }),
      created_at: new Date().toISOString()
    });

    // Mirror same appointment into Google Calendar when credentials exist.
    createJobEvent({
      ...lead,
      address: lead.address_text || lead.address || "",
      quote_amount: lead.quote_total_cents ? Math.round(Number(lead.quote_total_cents) / 100) : null,
      id: lead.from_phone
    }).catch(() => {});

    sendSms(
      parsed.phone,
      `You're booked ✅ ${timingPref}\nWe'll text before arrival. Reply HELP anytime.`
    ).catch(() => {});

    return res.json({ ok: true, timing_pref: timingPref });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/twilio/inbound", (req, res) => {
  const payload = req.body || {};
  const fromPhone = payload.From || payload.from || "unknown";
  const ts = new Date().toISOString();

  // Always respond immediately to Twilio
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");

  // Log raw event
  try {
    insertEvent.run({
      from_phone: fromPhone,
      event_type: "inbound_raw",
      payload_json: JSON.stringify(payload),
      created_at: ts
    });
  } catch (e) {}

  // Hand off to conversation state machine
  handleConversation(payload).catch((e) => {
    try {
      insertEvent.run({
        from_phone: fromPhone,
        event_type: "conversation_error",
        payload_json: JSON.stringify({ error: String(e && e.message ? e.message : e) }),
        created_at: new Date().toISOString()
      });
    } catch (e2) {}
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/contact.vcf", (_req, res) => {
  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:ICL Junk Removal",
    "ORG:ICL Junk Removal",
    "TEL;TYPE=CELL:+18555785014",
    "EMAIL:admin@icljunkremoval.com",
    "URL:https://icljunkremoval.com",
    "PHOTO;VALUE=URL:https://icl-twilio-intake-production.up.railway.app/public/logo.jpg",
    "END:VCARD"
  ].join("\n");
  res.set("Content-Type", "text/vcard");
  res.set("Content-Disposition", "attachment; filename=ICL-Junk-Removal.vcf");
  res.send(vcard);
});

app.get("/admin/twilio-latest", async (req, res) => {
  try {
    const from = String(req.query.from || "");
    if (!from) return res.status(400).json({ ok: false, error: "missing from" });
    const rows = await fetchLatest({ from, limit: 5 });
    res.json({ ok: true, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/media-proxy", async (req, res) => {
  try {
    const mediaUrl = req.query.u;
    if (!mediaUrl) return res.status(400).send("missing u");
    const sid = process.env.TWILIO_ACCOUNT_SID || "";
    const tok = process.env.TWILIO_AUTH_TOKEN || "";
    if (!sid || !tok) return res.status(500).send("twilio creds missing");
    const auth = Buffer.from(sid + ":" + tok).toString("base64");
    const r = await fetch(String(mediaUrl), { headers: { Authorization: "Basic " + auth }});
    if (!r.ok) return res.status(502).send("upstream " + r.status);
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

app.get("/admin/leads", async (_req, res) => {
  try {
    const rows = (await pool.query("SELECT from_phone, last_event, substr(coalesce(last_body,''),1,80) AS last_body_80, substr(coalesce(address_text,''),1,60) AS address_60, zip_text, num_media, media_url0, distance_miles, last_seen_at FROM leads ORDER BY last_seen_at DESC LIMIT 50")).rows;
    const esc = (s) => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
    const rowsHtml = rows.map(r => {
      const mediaHref = r.media_url0 ? ("/media-proxy?u=" + encodeURIComponent(r.media_url0)) : "";
      const mediaCell = mediaHref ? "<a target='_blank' href='" + mediaHref + "'>View</a>" : "";
      return "<tr><td><a href='/admin/lead/" + esc(String(r.from_phone).replaceAll("+","%2B")) + "'>" + esc(r.from_phone) + "</a></td><td>" + esc(r.last_event) + "</td><td>" + esc(r.last_body_80) + "</td><td>" + esc(r.address_60) + "</td><td>" + esc(r.zip_text) + "</td><td>" + esc(r.num_media) + "</td><td>" + mediaCell + "</td><td>" + esc(r.distance_miles) + "</td><td>" + esc(r.last_seen_at) + "</td></tr>";
    }).join("");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>ICL Leads</title><style>body{font-family:system-ui;padding:16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;font-size:13px}th{background:#f6f6f6}</style></head><body><h2>ICL Intake Leads</h2><table><thead><tr><th>From</th><th>Last Event</th><th>Last Message</th><th>Address</th><th>ZIP</th><th>Media#</th><th>Media</th><th>Miles</th><th>Last Seen</th></tr></thead><tbody>" + rowsHtml + "</tbody></table></body></html>");
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/lead/:from", (req, res) => {
  const fp = path.join(LEADS_DIR, safeFilenameFromPhone(req.params.from) + ".json");
  if (!fs.existsSync(fp)) return res.status(404).json({ ok: false });
  res.json(JSON.parse(fs.readFileSync(fp, "utf8")));
});

app.get("/admin/lead/:from", async (req, res) => {
  try {
    const from = req.params.from;
    const lead = (await pool.query("SELECT * FROM leads WHERE from_phone = $1", [from])).rows[0] || null;
    const events = (await pool.query("SELECT event_type, created_at, payload_json FROM events WHERE from_phone = $1 ORDER BY id DESC LIMIT 200", [from])).rows;
    const mediaUrls = [];
    for (const e of events) {
      try {
        const pj = JSON.parse(e.payload_json || "{}");
        const u = pj.MediaUrl0 || pj.mediaUrl0 || null;
        if (u && !mediaUrls.includes(u)) mediaUrls.push(u);
      } catch {}
    }
    const esc = (s) => String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
    const evHtml = events.map(e => "<tr><td>" + esc(e.created_at) + "</td><td>" + esc(e.event_type) + "</td><td><pre style='white-space:pre-wrap;margin:0'>" + esc(e.payload_json) + "</pre></td></tr>").join("");
    const mediaHtml = !mediaUrls.length ? "<p>No media.</p>" : mediaUrls.map((u,i) => "<div style='margin:10px 0'><a href='/media-proxy?u=" + encodeURIComponent(u) + "' target='_blank'>Open media " + (i+1) + "</a><br/><img src='/media-proxy?u=" + encodeURIComponent(u) + "' style='max-width:360px;border:1px solid #ddd;border-radius:10px;margin-top:6px'/></div>").join("");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>Lead " + esc(from) + "</title><style>body{font-family:system-ui;padding:16px}a{color:#0366d6}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px;font-size:12px;vertical-align:top}th{background:#f6f6f6}pre{max-width:100%;overflow-x:auto}</style></head><body><div><a href='/admin/leads'>← Back</a></div><h2>Lead: " + esc(from) + "</h2><pre>" + esc(JSON.stringify(lead,null,2)) + "</pre><h3>Media</h3>" + mediaHtml + "<h3>Events</h3><table><thead><tr><th>Time</th><th>Type</th><th>Payload</th></tr></thead><tbody>" + evHtml + "</tbody></table></body></html>");
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

setInterval(() => checkDropoffs().catch(e => console.error('[dropoff]', e.message)), 30*60*1000);
setTimeout(() => checkDropoffs().catch(()=>{}), 60*1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log("icl-twilio-intake listening on :" + PORT);
});

try {
  const mountTwilioExtraRoutes = require("./twilio_extra_routes");
  mountTwilioExtraRoutes(app, db, insertEvent);
  console.log("[twilio_extra_routes] mounted");
} catch (e) {
  console.error("[twilio_extra_routes] failed to mount:", e?.message || e);
}
