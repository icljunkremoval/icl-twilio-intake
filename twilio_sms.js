const twilio = require("twilio");

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getTwilioClient() {
  const sid = must("TWILIO_ACCOUNT_SID");
  const token = must("TWILIO_AUTH_TOKEN");
  return twilio(sid, token);
}

async function sendSms(to, body) {
  const client = getTwilioClient();
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_FROM_NUMBER;

  const payload = {
    to,
    body,
  };

  if (messagingServiceSid) payload.messagingServiceSid = messagingServiceSid;
  else if (from) payload.from = from;
  else throw new Error("Missing TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER");

  const msg = await client.messages.create(payload);
  return { sid: msg.sid, status: msg.status };
}

module.exports = { sendSms };
