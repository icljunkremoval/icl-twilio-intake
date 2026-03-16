const { db, pool, upsertLead, insertEvent, getLead } = require("./db");
const twilio = require("twilio");
const { sendSms } = require("./twilio_sms");
const { maybeCreateQuote } = require("./quote_worker");
const { analyzeJobMedia, analyzeAllMedia } = require("./vision_analyzer");
const { backfillLatestMedia } = require("./twilio_media_backfill");
const { recomputeDerived } = require("./recompute");
const { createJobEvent } = require("./calendar");
const APP_BASE_URL = String(process.env.APP_BASE_URL || "https://icl-twilio-intake-production.up.railway.app").replace(/\/+$/, "");

const STATES = {
  NEW: "NEW", AWAITING_MEDIA: "AWAITING_MEDIA", AWAITING_HAZMAT: "AWAITING_HAZMAT",
  AWAITING_ADDRESS: "AWAITING_ADDRESS", AWAITING_ACCESS: "AWAITING_ACCESS",
  AWAITING_LOAD: "AWAITING_LOAD", QUOTE_READY: "QUOTE_READY",
  AWAITING_DEPOSIT: "AWAITING_DEPOSIT", BOOKING_SENT: "BOOKING_SENT",
  WINDOW_SELECTED: "WINDOW_SELECTED", AWAITING_DAY: "AWAITING_DAY", ESCALATED: "ESCALATED",
};

const ACCESS_MAP = {
  "CURB": "CURB", "DRIVEWAY": "DRIVEWAY", "GARAGE": "GARAGE",
  "INSIDE HOME": "INSIDE_HOME", "INSIDE": "INSIDE_HOME",
  "STAIRS": "STAIRS", "APARTMENT": "APARTMENT", "OTHER": "OTHER",
};

const LOAD_MAP = {
  "SMALL": "MIN", "MEDIUM": "HALF", "LARGE": "FULL",
  "MIN": "MIN", "QTR": "QTR", "HALF": "HALF", "3Q": "3Q", "FULL": "FULL",
};

const WINDOW_MAP = {
  "1": "8-10am", "2": "10-12pm", "3": "12-2pm", "4": "2-4pm", "5": "4-6pm",
  "8": "8-10am", "10": "10-12pm", "12": "12-2pm", "2": "2-4pm", "4": "4-6pm",
  "8-10": "8-10am", "10-12": "10-12pm", "12-2": "12-2pm", "2-4": "2-4pm", "4-6": "4-6pm",
};

function getConvState(lead) { return (lead && lead.conv_state) || STATES.NEW; }

function logEvent(from_phone, event_type, data) {
  try { insertEvent.run({ from_phone, event_type, payload_json: JSON.stringify(data || {}), created_at: new Date().toISOString() }); } catch (e) {}
}

function setState(from_phone, state) {
  pool.query('UPDATE leads SET conv_state = $1, last_seen_at = NOW() WHERE from_phone = $2', [state, from_phone]).catch(e => console.error('[setState]', e.message));
}

function safeParseJson(v) {
  try { return JSON.parse(String(v || "{}")); } catch { return {}; }
}

async function latestConfirmationId(from_phone) {
  try {
    const row = (
      await pool.query(
        `SELECT payload_json
         FROM events
         WHERE from_phone = $1
           AND event_type IN ('deposit_paid', 'upfront_paid')
         ORDER BY id DESC
         LIMIT 1`,
        [from_phone]
      )
    ).rows[0];
    if (!row) return null;
    const payload = safeParseJson(row.payload_json);
    return payload.confirmation_id || null;
  } catch {
    return null;
  }
}

async function triggerQuote(from_phone) {
  await sendSms(from_phone, "Excellent — preparing your quote and checkout options now.");
  try { await recomputeDerived(from_phone); } catch (e) {}
  setTimeout(async () => { try { const r = await maybeCreateQuote(from_phone); if (!r.ok) logEvent(from_phone, "quote_trigger_failed", r); }
    catch (e) { logEvent(from_phone, "quote_trigger_error", { error: String(e.message || e) }); }
  }, 500);
}

async function advanceAfterAddress(from_phone) {
  const lead = await getLead.get(from_phone);
  const hasLoad = lead && lead.load_bucket;
  const hasAccess = lead && lead.access_level;
  if (hasLoad && hasAccess) {
    setState(from_phone, STATES.QUOTE_READY);
    await triggerQuote(from_phone);
  } else if (hasAccess && !hasLoad) {
    setState(from_phone, STATES.AWAITING_LOAD);
    await sendSms(from_phone, "How much are you removing?\n\nSMALL — pickup-truck bed\nMEDIUM — half a truck\nLARGE — full truck");
  } else {
    setState(from_phone, STATES.AWAITING_ACCESS);
    await sendSms(from_phone, "Where are the items?\n\nCURB / DRIVEWAY / GARAGE / INSIDE HOME / STAIRS / APARTMENT / OTHER");
  }
}

function runVisionAsync(from_phone, mediaUrl, allUrls) {
  const urlsToAnalyze = allUrls && allUrls.length > 0 ? allUrls : [mediaUrl];
  analyzeAllMedia(urlsToAnalyze).then((vision) => {
    logEvent(from_phone, "vision_analysis", vision);
    try {
      pool.query('UPDATE leads SET vision_analysis=$1,troll_flag=$2,crew_notes=$3,item_tags=$4,vision_load_bucket=$5,vision_access_level=$6,last_seen_at=NOW() WHERE from_phone=$7', [JSON.stringify(vision), vision.troll_flag?1:0, vision.crew_notes||null, JSON.stringify(vision.data_tags||[]), vision.load_bucket||null, vision.access_level||null, from_phone]).catch(()=>{});
    } catch(e) {
      pool.query('UPDATE leads SET vision_analysis=$1,troll_flag=$2,crew_notes=$3,item_tags=$4,last_seen_at=NOW() WHERE from_phone=$5', [JSON.stringify(vision),vision.troll_flag?1:0,vision.crew_notes||null,JSON.stringify(vision.data_tags||[]),from_phone]).catch(()=>{});
    }
    if (vision.troll_flag || !vision.is_valid_junk) {
      setState(from_phone, STATES.ESCALATED);
      sendSms(from_phone, "Thanks for reaching out! We couldn't identify junk removal items in your photo. Send a clearer photo or reply HELP to reach our team.").catch(()=>{});
      return;
    }
    const updates=[]; const params=[];
    if (vision.load_bucket && vision.load_confidence==="HIGH") { updates.push("load_bucket=?"); params.push(vision.load_bucket); logEvent(from_phone,"vision_load_set",{load_bucket:vision.load_bucket}); }
    if (vision.access_level && vision.access_level!=="UNKNOWN" && vision.access_confidence==="HIGH") { updates.push("access_level=?"); params.push(vision.access_level); logEvent(from_phone,"vision_access_set",{access_level:vision.access_level}); }
    if (updates.length>0) {
      const cols = updates.map(u => u.split('=')[0]);
      const pgU = cols.map((col, idx) => col+'=$'+(idx+1));
      params.push(from_phone);
      pool.query("UPDATE leads SET "+pgU.join(",")+",last_seen_at=NOW() WHERE from_phone=$"+(cols.length+1), params).catch(()=>{});
    }
  }).catch((e)=>{ logEvent(from_phone,"vision_error",{error:String(e.message||e)}); });
}

async function handleConversation(payload) {
  const from_phone = payload.From;
  const to_phone = payload.To;
  const body = (payload.Body || "").trim();
  const numMedia = Number(payload.NumMedia || 0);
  const mediaUrl = payload.MediaUrl0 || "";
  // Capture all media URLs for multi-photo support
  const allMediaUrls = [];
  for (let i = 0; i < Math.min(numMedia, 10); i++) {
    const u = payload["MediaUrl" + i];
    if (u) allMediaUrls.push(u);
  }
  const bodyUpper = body.toUpperCase();

  try { upsertLead.run({from_phone,to_phone,ts:new Date().toISOString(),last_event:"message",last_body:body,num_media:numMedia,media_url0:mediaUrl||null}); } catch(e){}
  // Alert ops on first contact
  try {
    const existingLead = await getLead.get(from_phone);
    const eventCount = await pool.query("SELECT COUNT(*) as cnt FROM events WHERE from_phone=$1", [from_phone]);
    if (parseInt(eventCount.rows[0].cnt) <= 1) {
      sendSms("+12138806318", "📲 NEW LEAD\n" + from_phone + "\nJust texted in. Flow started.").catch(()=>{});
    }
  } catch(e) {}

  const lead = await getLead.get(from_phone);
  const state = getConvState(lead);

  if (bodyUpper==="URGENT") { logEvent(from_phone,"urgent_flag",{body}); await sendSms(from_phone,"Got it — flagged URGENT. We'll prioritize your job."); return; }
  if (bodyUpper==="HELP") {
    logEvent(from_phone,"help_requested",{body});
    setState(from_phone,STATES.ESCALATED);
    await sendSms(from_phone,"Connecting you now — expect a call from 213-880-6318 in seconds.");
    await sendSms("+12138806318", "HELP REQUEST\nPhone: "+from_phone+"\nLast message: "+body+"\nCalling them now.");
    try {
      const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilioClient.calls.create({
        to: from_phone,
        from: "+12138806318",
        twiml: "<Response><Say voice=\"Google.en-US-Neural2-F\">This is ICL Junk Removal. A team member will be with you shortly. Please hold.</Say><Dial>+12138806318</Dial></Response>"
      });
      logEvent(from_phone,"help_call_initiated",{});
    } catch(e) {
      console.error("[help] call failed:", e.message);
      await sendSms(from_phone,"Please call us directly at 213-880-6318 and we will take care of you.");
    }
    return;
  }

  switch(state) {
    case STATES.NEW:
    case STATES.AWAITING_MEDIA: {
      const isVideo = (payload.MediaContentType0||"").includes("video");
      if (isVideo) { await sendSms(from_phone, "Got it! Videos don't come through our system — can you send still photos instead? Different angles help us give you the most accurate quote."); break; }
      if (numMedia>0||mediaUrl) {
        try { upsertLead.run({from_phone,to_phone,ts:new Date().toISOString(),last_event:"media_received",last_body:body,num_media:numMedia,media_url0:mediaUrl||null}); } catch(e){}
        logEvent(from_phone,"media_received",{numMedia,mediaUrl});
        setState(from_phone,STATES.AWAITING_HAZMAT);
        pool.query(
          `UPDATE leads
           SET has_media=1,
               quote_ready=0,
               quote_status=NULL,
               square_payment_link_id=NULL,
               square_payment_link_url=NULL,
               square_order_id=NULL,
               square_upfront_payment_link_id=NULL,
               square_upfront_payment_link_url=NULL,
               square_upfront_order_id=NULL,
               quote_total_cents=NULL,
               upfront_total_cents=NULL,
               upfront_discount_pct=NULL,
               deposit_paid=0,
               deposit_paid_at=NULL,
               timing_pref=NULL,
               conv_state=$1,
               last_seen_at=NOW()
           WHERE from_phone=$2`,
          [STATES.AWAITING_HAZMAT, from_phone]
        ).catch(()=>{});
        if (allMediaUrls.length>0) runVisionAsync(from_phone, allMediaUrls[0], allMediaUrls);
        await sendSms(from_phone,"Got it — quick safety check: any paint, chemicals, fuel, batteries, asbestos, or medical waste in the mix?\n\nReply YES or NO");
      } else {
        setState(from_phone,STATES.AWAITING_MEDIA);
        backfillLatestMedia({from:from_phone,maxAgeSeconds:120}).then((b)=>{
          if (b&&b.mediaUrl0) {
            pool.query(
              `UPDATE leads
               SET has_media=1,
                   num_media=$1,
                   media_url0=$2,
                   quote_ready=0,
                   quote_status=NULL,
                   square_payment_link_id=NULL,
                   square_payment_link_url=NULL,
                   square_order_id=NULL,
                   square_upfront_payment_link_id=NULL,
                   square_upfront_payment_link_url=NULL,
                   square_upfront_order_id=NULL,
                   quote_total_cents=NULL,
                   upfront_total_cents=NULL,
                   upfront_discount_pct=NULL,
                   deposit_paid=0,
                   deposit_paid_at=NULL,
                   timing_pref=NULL,
                   conv_state=$3,
                   last_seen_at=NOW()
               WHERE from_phone=$4`,
              [b.numMedia, b.mediaUrl0, STATES.AWAITING_HAZMAT, from_phone]
            ).catch(()=>{});
            setState(from_phone,STATES.AWAITING_HAZMAT);
            logEvent(from_phone,"media_backfill_hit",b);
            runVisionAsync(from_phone,b.mediaUrl0,[b.mediaUrl0]);
            sendSms(from_phone,"Got it — quick safety check: any paint, chemicals, fuel, batteries, asbestos, or medical waste?\n\nReply YES or NO").catch(()=>{});
          } else {
            pool.query("SELECT COUNT(*) as cnt FROM events WHERE from_phone=$1", [from_phone]).then(evtR => {
              const isCaller = parseInt(evtR.rows[0].cnt) <= 1;
              const msg = isCaller
                ? "Hey! You just called us — glad you reached out. Go ahead and send up to 10 photos of what needs to go — different angles help us give you the most accurate quote. 📦\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote."
                : "Hi! Thanks for texting ICL Junk Removal.\n\nSend us up to 10 photos of what you need removed — different angles help us give you the most accurate quote.\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote.";
              sendSms(from_phone, msg).then(() => {
              sendSms(from_phone, "Save our contact card: " + APP_BASE_URL + "/contact.vcf").catch(()=>{});
            }).catch(()=>{});
            }).catch(()=>{ sendSms(from_phone,"Hi! Thanks for texting ICL Junk Removal.\n\nSend us up to 10 photos of what you need removed — different angles help us give you the most accurate quote.\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote.").catch(()=>{}); });
          }
        }).catch(()=>{ sendSms(from_phone,"Hi! Thanks for texting ICL Junk Removal.\n\nSend us up to 10 photos of what you need removed — different angles help us give you the most accurate quote.\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote.").catch(()=>{}); });
      }
      break;
    }

    case STATES.AWAITING_HAZMAT: {
      if (numMedia>0||mediaUrl) { if(allMediaUrls.length>0) runVisionAsync(from_phone,allMediaUrls[0],allMediaUrls); await sendSms(from_phone,"Got your photos! Any paint, chemicals, fuel, batteries, asbestos, or medical waste?\n\nReply YES or NO"); break; }
      if (bodyUpper==="YES") {
        logEvent(from_phone,"hazmat_yes",{body}); setState(from_phone,STATES.ESCALATED);
        await sendSms(from_phone,"Thanks for the heads up — restricted materials need special handling. A team member will reach out to discuss options.");
        await sendSms("+12138806318", "🚨 HAZMAT LEAD\nPhone: "+from_phone+"\nAddress: "+(lead&&lead.address_text||"not yet provided")+"\nCall them back ASAP.");
      } else if (bodyUpper.startsWith("NO")||bodyUpper==="N") {
        logEvent(from_phone,"hazmat_no",{body}); setState(from_phone,STATES.AWAITING_ADDRESS);
        await sendSms(from_phone,"What's the service address? Cross streets + ZIP works too.");
      } else {
        await sendSms(from_phone,"Reply YES or NO — any restricted materials like paint, chemicals, or medical waste?");
      }
      break;
    }

    case STATES.AWAITING_ADDRESS: {
      if (body.length<3) { await sendSms(from_phone,"Please send the service address or nearest cross streets + ZIP."); break; }
      const zipMatch=body.match(/\b(\d{5})\b/); const zip=zipMatch?zipMatch[1]:null;
      await pool.query('UPDATE leads SET address_text=$1,zip=$2,zip_text=$2,last_seen_at=NOW() WHERE from_phone=$3', [body,zip,from_phone]);
      logEvent(from_phone,"address_capture",{address:body,zip});
      await sendSms(from_phone, "Excellent — we have " + body + " confirmed. We're preparing your quote now.");
      await advanceAfterAddress(from_phone);
      break;
    }

    case STATES.AWAITING_ACCESS: {
      let accessLevel=null;
      for(const [key,val] of Object.entries(ACCESS_MAP)){if(bodyUpper.includes(key)){accessLevel=val;break;}}
      if (!accessLevel) { await sendSms(from_phone,"Reply with: CURB / DRIVEWAY / GARAGE / INSIDE HOME / STAIRS / APARTMENT / OTHER"); break; }
      await pool.query("UPDATE leads SET access_level=$1, customer_access_level=$1, last_seen_at=NOW() WHERE from_phone=$2", [accessLevel, from_phone]);
      logEvent(from_phone,"access_capture",{access_level:accessLevel});
      const afterAccess=await getLead.get(from_phone);
      if (afterAccess&&afterAccess.load_bucket) { setState(from_phone,STATES.QUOTE_READY); await triggerQuote(from_phone); }
      else { setState(from_phone,STATES.AWAITING_LOAD); await sendSms(from_phone,"How much are you removing?\n\nSMALL — pickup-truck bed\nMEDIUM — half a truck\nLARGE — full truck"); }
      break;
    }

    case STATES.AWAITING_LOAD: {
      let loadBucket=null;
      for(const [key,val] of Object.entries(LOAD_MAP)){if(bodyUpper.includes(key)){loadBucket=val;break;}}
      if (!loadBucket) { await sendSms(from_phone,"Reply SMALL, MEDIUM, or LARGE."); break; }
      await pool.query("UPDATE leads SET load_bucket=$1, customer_load_bucket=$1, conv_state=$2, last_seen_at=NOW() WHERE from_phone=$3", [loadBucket, STATES.QUOTE_READY, from_phone]);
      logEvent(from_phone,"load_capture",{load_bucket:loadBucket});
      await triggerQuote(from_phone);
      break;
    }

    case STATES.AWAITING_DEPOSIT: {
      const needsResend = bodyUpper.includes("RESEND") || bodyUpper.includes("LINK") || bodyUpper.includes("PAY") || bodyUpper.includes("CHECKOUT");
      if (needsResend) {
        const cur = await getLead.get(from_phone);
        const depositUrl = cur?.square_payment_link_url || null;
        const upfrontUrl = cur?.square_upfront_payment_link_url || null;
        const quoteTotal = Number(cur?.quote_total_cents || 0);
        const upfrontTotal = Number(cur?.upfront_total_cents || 0);
        const savings = quoteTotal > 0 && upfrontTotal > 0 ? Math.max(0, Math.round((quoteTotal - upfrontTotal) / 100)) : null;
        const lines = ["Here are your checkout links again:"];
        if (depositUrl) {
          lines.push("");
          lines.push("1) Reserve with $50 deposit:");
          lines.push(depositUrl);
        }
        if (upfrontUrl) {
          lines.push("");
          lines.push(`2) Pay upfront and save 10%${savings != null ? ` ($${savings} off)` : ""}:`);
          lines.push(upfrontUrl);
        }
        lines.push("");
        lines.push("After payment, you'll get confirmation + your scheduling step.");
        await sendSms(from_phone, lines.join("\n"));
        break;
      }
      await sendSms(from_phone,"Your checkout links are ready. Reply RESEND to get both links again, or pay now to lock your scheduling step.");
      break;
    }

    case STATES.BOOKING_SENT: {
      let window=null;
      for(const [key,val] of Object.entries(WINDOW_MAP)){if(bodyUpper.includes(key)){window=val;break;}}
      if (!window) { await sendSms(from_phone,"Reply 1–5 for your arrival window:\n1) 8–10am\n2) 10am–12pm\n3) 12–2pm\n4) 2–4pm\n5) 4–6pm"); break; }
      // Save window temporarily, ask for day
      await pool.query('UPDATE leads SET timing_pref=$1,conv_state=$2,last_seen_at=NOW() WHERE from_phone=$3', [window,STATES.AWAITING_DAY,from_phone]);
      logEvent(from_phone,"window_selected",{timing_pref:window});
      // Build day options with 4hr buffer for same-day
      const now = new Date();
      const days = [];
      const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      // Window start hours
      const windowStarts = {"8-10am":8,"10-12pm":10,"12-2pm":12,"2-4pm":14,"4-6pm":16};
      const winStart = windowStarts[window] || 8;
      for (let d=0; d<3; d++) {
        const date = new Date(now);
        date.setDate(now.getDate() + d);
        if (d===0) {
          // Same day: only show if window start is 4+ hours away
          const hoursUntil = winStart - now.getHours();
          if (hoursUntil < 4) continue;
        }
        const label = dayNames[date.getDay()] + " " + monthNames[date.getMonth()] + " " + date.getDate();
        days.push(label);
      }
      // If same-day was skipped, add a 4th day
      while (days.length < 3) {
        const date = new Date(now);
        date.setDate(now.getDate() + days.length + (days[0] && days[0].startsWith(dayNames[now.getDay()]) ? 0 : 1));
        const label = dayNames[date.getDay()] + " " + monthNames[date.getMonth()] + " " + date.getDate();
        if (!days.includes(label)) days.push(label);
      }
      const dayMenu = days.map((d,i) => (i+1) + ") " + d).join("\n");
      await sendSms(from_phone, "Got it! What day works for you?\n\n" + dayMenu + "\n\nReply 1, 2, or 3.");
      break;
    }

    case STATES.AWAITING_DAY: {
      const dayChoice = body.trim();
      const now2 = new Date();
      const dayNames2 = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
      const monthNames2 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const windowStarts2 = {"8-10am":8,"10-12pm":10,"12-2pm":12,"2-4pm":14,"4-6pm":16};
      const savedWindow = lead && lead.timing_pref ? lead.timing_pref : "";
      const winStart2 = windowStarts2[savedWindow] || 8;
      const availDays = [];
      for (let d=0; d<3; d++) {
        const date = new Date(now2);
        date.setDate(now2.getDate() + d);
        if (d===0) { if ((winStart2 - now2.getHours()) < 4) continue; }
        availDays.push(dayNames2[date.getDay()] + " " + monthNames2[date.getMonth()] + " " + date.getDate());
      }
      while (availDays.length < 3) {
        const date = new Date(now2);
        date.setDate(now2.getDate() + availDays.length + 1);
        const label = dayNames2[date.getDay()] + " " + monthNames2[date.getMonth()] + " " + date.getDate();
        if (!availDays.includes(label)) availDays.push(label);
      }
      const idx = parseInt(dayChoice) - 1;
      if (isNaN(idx) || idx < 0 || idx >= availDays.length) {
        const dayMenu2 = availDays.map((d,i) => (i+1) + ") " + d).join("\n");
        await sendSms(from_phone, "Please reply 1, 2, or 3:\n\n" + dayMenu2);
        break;
      }
      const chosenDay = availDays[idx];
      const fullTiming = chosenDay + ", " + savedWindow;
      await pool.query(
        'UPDATE leads SET timing_pref=$1,conv_state=$2,quote_status=$2,last_seen_at=NOW() WHERE from_phone=$3',
        [fullTiming,STATES.WINDOW_SELECTED,from_phone]
      );
      logEvent(from_phone,"day_selected",{timing_pref:fullTiming});
      const updatedLead = (await pool.query('SELECT * FROM leads WHERE from_phone=$1',[from_phone])).rows[0];
      let calendarResult = null;
      try {
        calendarResult = await createJobEvent(updatedLead);
      } catch (e) {
        console.error('[calendar] event error:', e);
      }
      if (calendarResult && calendarResult.id) {
        await pool.query(
          `UPDATE leads
           SET calendar_event_id = $1,
               calendar_event_url = $2,
               calendar_sync_status = 'SYNCED',
               calendar_synced_at = NOW(),
               last_seen_at = NOW()
           WHERE from_phone = $3`,
          [calendarResult.id, calendarResult.htmlLink || null, from_phone]
        );
        logEvent(from_phone, "calendar_event_created", {
          source: "sms_schedule",
          calendar_event_id: calendarResult.id,
          calendar_event_url: calendarResult.htmlLink || null
        });
      } else if (calendarResult && calendarResult.reason === "calendar_not_configured") {
        await pool.query(
          `UPDATE leads
           SET calendar_sync_status = 'NOT_CONFIGURED',
               calendar_synced_at = NOW(),
               last_seen_at = NOW()
           WHERE from_phone = $1`,
          [from_phone]
        );
        logEvent(from_phone, "calendar_event_skipped", { source: "sms_schedule", reason: "calendar_not_configured" });
      } else {
        await pool.query(
          `UPDATE leads
           SET calendar_sync_status = 'FAILED',
               calendar_synced_at = NOW(),
               last_seen_at = NOW()
           WHERE from_phone = $1`,
          [from_phone]
        );
        logEvent(from_phone, "calendar_event_failed", { source: "sms_schedule" });
      }
      const confId = await latestConfirmationId(from_phone);
      await sendSms(
        from_phone,
        "Locked in! ✅ ICL Junk Removal arrives " + fullTiming + ".\n" +
        (confId ? ("Confirmation #" + confId + "\n") : "") +
        "We'll text you when we're on our way. Questions? Reply HELP anytime."
      );
      logEvent(from_phone, "booking_confirmation_sms_sent", {
        source: "sms_schedule",
        timing_pref: fullTiming,
        confirmation_id: confId || null
      });
      break;
    }

    case STATES.WINDOW_SELECTED: {
      await sendSms(from_phone,`You're all set — ${lead&&lead.timing_pref?lead.timing_pref:"arrival confirmed"}. Reply HELP if anything changes.`);
      break;
    }

    case STATES.ESCALATED: {
      if (numMedia > 0 || mediaUrl) {
        setState(from_phone, STATES.AWAITING_MEDIA);
        if (allMediaUrls.length > 0) runVisionAsync(from_phone, allMediaUrls[0], allMediaUrls);
        await sendSms(from_phone, "Got your photo — analyzing now. We'll have your quote ready shortly.");
        break;
      }
      if (bodyUpper === "HELP") {
        await sendSms(from_phone, "A team member will be in touch shortly. You can also call 855-578-5014.");
        await sendSms("+12138806318", "HELP FOLLOW-UP\nPhone: " + from_phone + "\nCall them back ASAP.");
        break;
      }
      await sendSms(from_phone, "We're here! You can:\n\nSend a photo to get a quote\nCall 855-578-5014\nReply HELP to reach our team");
      break;
    }

    default: {
      setState(from_phone,STATES.NEW);
      // Check if caller followup
    try {
      const evtCheck2 = await pool.query("SELECT COUNT(*) as cnt FROM events WHERE from_phone=$1", [from_phone]);
      const isCallerFollowup2 = parseInt(evtCheck2.rows[0].cnt) <= 1;
      const greeting2 = isCallerFollowup2
        ? "Hey! You just called us — glad you reached out. Go ahead and send up to 10 photos of what needs to go — different angles help us give you the most accurate quote. 📦\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote."
        : "Hi! Thanks for texting ICL Junk Removal. Send us up to 10 photos of what needs to go — different angles help us give you the most accurate quote.\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote.";
      await sendSms(from_phone, greeting2);
    } catch(e) {
      await sendSms(from_phone,"Hi! Thanks for texting ICL Junk Removal. Send us up to 10 photos of what needs to go — different angles help us give you the most accurate quote.\n\n⚠️ Any item visible in your photos will be flagged for removal and included in your quote.");
    }
    }
  }
}

module.exports = { handleConversation, STATES };
