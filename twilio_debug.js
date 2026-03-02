const twilio = require("twilio");

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function fetchLatest({ from, limit = 5 }) {
  const c = twilio(must("TWILIO_ACCOUNT_SID"), must("TWILIO_AUTH_TOKEN"));
  const msgs = await c.messages.list({ from, limit });
  return msgs.map(m => ({
    sid: m.sid,
    from: m.from,
    to: m.to,
    numMedia: Number(m.numMedia || 0),
    dateSent: m.dateSent ? new Date(m.dateSent).toISOString() : null,
  }));
}

module.exports = { fetchLatest };
