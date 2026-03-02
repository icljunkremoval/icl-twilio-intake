const twilio = require("twilio");

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function client() {
  return twilio(must("TWILIO_ACCOUNT_SID"), must("TWILIO_AUTH_TOKEN"));
}

// Find the newest MMS (MM...) from this sender within maxAgeSeconds that has media
async function backfillLatestMedia({ from, maxAgeSeconds = 300 }) {
  if (!from) return null;

  const c = client();
  const now = Date.now();

  // Pull a handful; prefer MMS (sid starts with MM) and numMedia>0
  const msgs = await c.messages.list({ from, limit: 20 });
  if (!msgs || !msgs.length) return null;

  // Sort newest-first defensively
  msgs.sort((a,b) => {
    const ta = a.dateSent ? new Date(a.dateSent).getTime() : 0;
    const tb = b.dateSent ? new Date(b.dateSent).getTime() : 0;
    return tb - ta;
  });

  for (const m of msgs) {
    const nm = Number(m.numMedia || 0);
    if (nm <= 0) continue;

    // Prefer MMS SIDs (MM...) if present
    if (String(m.sid || "").startsWith("SM")) continue;

    const sent = m.dateSent ? new Date(m.dateSent).getTime() : now;
    const ageSec = Math.abs(now - sent) / 1000;
    if (ageSec > maxAgeSeconds) continue;

    const media = await c.messages(m.sid).media.list({ limit: 1 });
    if (!media || !media.length) continue;

    const fullUrl = `https://api.twilio.com${media[0].uri.replace(/\\.json$/i, "")}`;
    return { numMedia: nm, mediaUrl0: fullUrl, messageSid: m.sid, to: m.to, dateSent: m.dateSent ? new Date(m.dateSent).toISOString() : null };
  }

  // Fallback: allow SM... if Twilio ever uses it with media (rare)
  for (const m of msgs) {
    const nm = Number(m.numMedia || 0);
    if (nm <= 0) continue;

    const sent = m.dateSent ? new Date(m.dateSent).getTime() : now;
    const ageSec = Math.abs(now - sent) / 1000;
    if (ageSec > maxAgeSeconds) continue;

    const media = await c.messages(m.sid).media.list({ limit: 1 });
    if (!media || !media.length) continue;

    const fullUrl = `https://api.twilio.com${media[0].uri.replace(/\\.json$/i, "")}`;
    return { numMedia: nm, mediaUrl0: fullUrl, messageSid: m.sid, to: m.to, dateSent: m.dateSent ? new Date(m.dateSent).toISOString() : null };
  }

  return null;
}

module.exports = { backfillLatestMedia };
