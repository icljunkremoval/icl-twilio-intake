const { db, upsertLead, insertEvent, getLead } = require("./db");
const { sendSms } = require("./twilio_sms");
const { maybeCreateQuote } = require("./quote_worker");
const { analyzeJobMedia } = require("./vision_analyzer");
const { backfillLatestMedia } = require("./twilio_media_backfill");
const { recomputeDerived } = require("./recompute");

const STATES = {
  NEW: "NEW", AWAITING_MEDIA: "AWAITING_MEDIA", AWAITING_HAZMAT: "AWAITING_HAZMAT",
  AWAITING_ADDRESS: "AWAITING_ADDRESS", AWAITING_ACCESS: "AWAITING_ACCESS",
  AWAITING_LOAD: "AWAITING_LOAD", QUOTE_READY: "QUOTE_READY",
  AWAITING_DEPOSIT: "AWAITING_DEPOSIT", BOOKING_SENT: "BOOKING_SENT",
  WINDOW_SELECTED: "WINDOW_SELECTED", ESCALATED: "ESCALATED",
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
  "1": "9-11", "2": "12-2", "3": "3-5",
  "9": "9-11", "12": "12-2", "9-11": "9-11", "12-2": "12-2", "3-5": "3-5",
};

function getConvState(lead) { return (lead && lead.conv_state) || STATES.NEW; }

function logEvent(from_phone, event_type, data) {
  try { insertEvent.run({ from_phone, event_type, payload_json: JSON.stringify(data || {}), created_at: new Date().toISOString() }); } catch (e) {}
}

function setState(from_phone, state) {
  db.prepare(`UPDATE leads SET conv_state = ?, last_seen_at = NOW() WHERE from_phone = ?`).run(state, from_phone);
}

async function triggerQuote(from_phone) {
  await sendSms(from_phone, "Got it — here's your upfront quote.");
  try { await recomputeDerived(from_phone); } catch (e) {}
  setTimeout(async () => { const dbg = await getLead.get(from_phone); console.log("[quote_debug]", JSON.stringify({quote_ready: dbg?.quote_ready, load: dbg?.load_bucket, access: dbg?.access_level, has_media: dbg?.has_media, addr: dbg?.address_text}));
    try { const r = await maybeCreateQuote(from_phone); console.log("[quote_result]", JSON.stringify(r)); if (!r.ok) logEvent(from_phone, "quote_trigger_failed", r); }
    catch (e) { console.error("[quote_catch]", String(e.message || e), e.stack); logEvent(from_phone, "quote_trigger_error", { error: String(e.message || e) }); }
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

function runVisionAsync(from_phone, mediaUrl) {
  analyzeJobMedia(mediaUrl).then((vision) => {
    logEvent(from_phone, "vision_analysis", vision);
    try {
      db.prepare(`UPDATE leads SET vision_analysis=?,troll_flag=?,crew_notes=?,item_tags=?,vision_load_bucket=?,vision_access_level=?,last_seen_at=NOW() WHERE from_phone=?`)
        .run(JSON.stringify(vision), vision.troll_flag?1:0, vision.crew_notes||null, JSON.stringify(vision.data_tags||[]), vision.load_bucket||null, vision.access_level||null, from_phone);
    } catch(e) {
      try { db.prepare(`UPDATE leads SET vision_analysis=?,troll_flag=?,crew_notes=?,item_tags=?,last_seen_at=NOW() WHERE from_phone=?`).run(JSON.stringify(vision),vision.troll_flag?1:0,vision.crew_notes||null,JSON.stringify(vision.data_tags||[]),from_phone); } catch(e2){}
    }
    if (vision.troll_flag || !vision.is_valid_junk) {
      setState(from_phone, STATES.ESCALATED);
      sendSms(from_phone, "Thanks for reaching out! We couldn't identify junk removal items in your photo. Send a clearer photo or reply HELP to reach our team.").catch(()=>{});
      return;
    }
    const updates=[]; const params=[];
    if (vision.load_bucket && vision.load_confidence==="HIGH") { updates.push("load_bucket=?"); params.push(vision.load_bucket); logEvent(from_phone,"vision_load_set",{load_bucket:vision.load_bucket}); }
    if (vision.access_level && vision.access_level!=="UNKNOWN" && vision.access_confidence==="HIGH") { updates.push("access_level=?"); params.push(vision.access_level); logEvent(from_phone,"vision_access_set",{access_level:vision.access_level}); }
    if (updates.length>0) { params.push(from_phone); db.prepare("UPDATE leads SET "+updates.join(",")+",last_seen_at=NOW() WHERE from_phone=?").run(...params); }
  }).catch((e)=>{ logEvent(from_phone,"vision_error",{error:String(e.message||e)}); });
}

async function handleConversation(payload) {
  const from_phone = payload.From;
  const to_phone = payload.To;
  const body = (payload.Body || "").trim();
  const numMedia = Number(payload.NumMedia || 0);
  const mediaUrl = payload.MediaUrl0 || "";
  const bodyUpper = body.toUpperCase();

  try { upsertLead.run({from_phone,to_phone,ts:new Date().toISOString(),last_event:"message",last_body:body,num_media:numMedia,media_url0:mediaUrl||null}); } catch(e){}

  const lead = await getLead.get(from_phone);
  const state = getConvState(lead);

  if (bodyUpper==="URGENT") { logEvent(from_phone,"urgent_flag",{body}); await sendSms(from_phone,"Got it — flagged URGENT. We'll prioritize your job."); return; }
  if (bodyUpper==="HELP") { logEvent(from_phone,"help_requested",{body}); setState(from_phone,STATES.ESCALATED); await sendSms(from_phone,"A team member will reach out shortly. You can also call 855-578-5014."); return; }

  switch(state) {
    case STATES.NEW:
    case STATES.AWAITING_MEDIA: {
      if (numMedia>0||mediaUrl) {
        try { upsertLead.run({from_phone,to_phone,ts:new Date().toISOString(),last_event:"media_received",last_body:body,num_media:numMedia,media_url0:mediaUrl||null}); } catch(e){}
        logEvent(from_phone,"media_received",{numMedia,mediaUrl});
        setState(from_phone,STATES.AWAITING_HAZMAT);
        db.prepare(`UPDATE leads SET has_media=1,last_seen_at=NOW() WHERE from_phone=?`).run(from_phone);
        if (mediaUrl) runVisionAsync(from_phone,mediaUrl);
        await sendSms(from_phone,"Got it — quick safety check: any paint, chemicals, fuel, batteries, asbestos, or medical waste in the mix?\n\nReply YES or NO");
      } else {
        setState(from_phone,STATES.AWAITING_MEDIA);
        backfillLatestMedia({from:from_phone,maxAgeSeconds:120}).then((b)=>{
          if (b&&b.mediaUrl0) {
            try { db.prepare(`UPDATE leads SET has_media=1,num_media=?,media_url0=?,last_seen_at=NOW() WHERE from_phone=?`).run(b.numMedia,b.mediaUrl0,from_phone); } catch(e){}
            setState(from_phone,STATES.AWAITING_HAZMAT);
            logEvent(from_phone,"media_backfill_hit",b);
            runVisionAsync(from_phone,b.mediaUrl0);
            sendSms(from_phone,"Got it — quick safety check: any paint, chemicals, fuel, batteries, asbestos, or medical waste?\n\nReply YES or NO").catch(()=>{});
          } else {
            sendSms(from_phone,"Hi! Thanks for texting ICL Junk Removal.\n\nSend us a photo of what you need removed and we'll build your upfront quote.").catch(()=>{});
          }
        }).catch(()=>{ sendSms(from_phone,"Hi! Thanks for texting ICL Junk Removal.\n\nSend us a photo of what you need removed and we'll build your upfront quote.").catch(()=>{}); });
      }
      break;
    }

    case STATES.AWAITING_HAZMAT: {
      if (numMedia>0||mediaUrl) { if(mediaUrl) runVisionAsync(from_phone,mediaUrl); await sendSms(from_phone,"Got the photo. Any paint, chemicals, fuel, batteries, asbestos, or medical waste?\n\nReply YES or NO"); break; }
      if (bodyUpper==="YES") {
        logEvent(from_phone,"hazmat_yes",{body}); setState(from_phone,STATES.ESCALATED);
        await sendSms(from_phone,"Thanks for the heads up — restricted materials need special handling. A team member will reach out to discuss options.");
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
      db.prepare(`UPDATE leads SET address_text=?,zip=?,zip_text=?,last_seen_at=NOW() WHERE from_phone=?`).run(body,zip,zip,from_phone);
      logEvent(from_phone,"address_capture",{address:body,zip});
      await advanceAfterAddress(from_phone);
      break;
    }

    case STATES.AWAITING_ACCESS: {
      let accessLevel=null;
      for(const [key,val] of Object.entries(ACCESS_MAP)){if(bodyUpper.includes(key)){accessLevel=val;break;}}
      if (!accessLevel) { await sendSms(from_phone,"Reply with: CURB / DRIVEWAY / GARAGE / INSIDE HOME / STAIRS / APARTMENT / OTHER"); break; }
      try { db.prepare(`UPDATE leads SET access_level=?,customer_access_level=?,last_seen_at=NOW() WHERE from_phone=?`).run(accessLevel,accessLevel,from_phone); }
      catch(e) { db.prepare(`UPDATE leads SET access_level=?,last_seen_at=NOW() WHERE from_phone=?`).run(accessLevel,from_phone); }
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
      try { db.prepare(`UPDATE leads SET load_bucket=?,customer_load_bucket=?,conv_state=?,last_seen_at=NOW() WHERE from_phone=?`).run(loadBucket,loadBucket,STATES.QUOTE_READY,from_phone); }
      catch(e) { db.prepare(`UPDATE leads SET load_bucket=?,conv_state=?,last_seen_at=NOW() WHERE from_phone=?`).run(loadBucket,STATES.QUOTE_READY,from_phone); }
      logEvent(from_phone,"load_capture",{load_bucket:loadBucket});
      await triggerQuote(from_phone);
      break;
    }

    case STATES.AWAITING_DEPOSIT: {
      await sendSms(from_phone,"Your deposit link is waiting — place the $50 to lock your arrival window. Reply HELP if you need it resent.");
      break;
    }

    case STATES.BOOKING_SENT: {
      let window=null;
      for(const [key,val] of Object.entries(WINDOW_MAP)){if(bodyUpper.includes(key)){window=val;break;}}
      if (!window) { await sendSms(from_phone,"Reply 1, 2, or 3:\n1) 9–11 AM\n2) 12–2 PM\n3) 3–5 PM"); break; }
      db.prepare(`UPDATE leads SET timing_pref=?,conv_state=?,last_seen_at=NOW() WHERE from_phone=?`).run(window,STATES.WINDOW_SELECTED,from_phone);
      logEvent(from_phone,"window_selected",{timing_pref:window});
      await sendSms(from_phone,`Locked in. ICL Junk Removal arrives ${window}. You'll get a heads-up when we're on the way.\n\nQuestions? Reply HELP anytime.`);
      break;
    }

    case STATES.WINDOW_SELECTED: {
      await sendSms(from_phone,`You're all set — arrival window ${lead&&lead.timing_pref?lead.timing_pref:"confirmed"}. Reply HELP if anything changes.`);
      break;
    }

    case STATES.ESCALATED: {
      await sendSms(from_phone,"A team member will be in touch shortly. Reply HELP to flag this again.");
      break;
    }

    default: {
      setState(from_phone,STATES.NEW);
      await sendSms(from_phone,"Hi! Thanks for texting ICL Junk Removal. Send us a photo of what needs to go and we'll get you a quote.");
    }
  }
}

module.exports = { handleConversation, STATES };
