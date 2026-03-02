import re, sys

with open("/Users/icl-agent/icl-twilio-intake/server.js", "r") as f:
    content = f.read()

# Add require for conversation.js after the last require line near the top
old_require = 'const { evaluateQuoteReadyRow } = require("./quote_gate");'
new_require = '''const { evaluateQuoteReadyRow } = require("./quote_gate");
const { handleConversation } = require("./conversation");'''

if 'require("./conversation")' not in content:
    content = content.replace(old_require, new_require)
    print("Added conversation require")
else:
    print("conversation require already present")

# Find and replace the entire /twilio/inbound handler
start_marker = 'app.post("/twilio/inbound", (req, res) => {'
end_marker = 'app.get("/health", (_req, res) => res.json({ ok: true }));'

start_idx = content.find(start_marker)
end_idx = content.find(end_marker)

if start_idx == -1:
    print("ERROR: Could not find start of inbound handler")
    sys.exit(1)

if end_idx == -1:
    print("ERROR: Could not find health endpoint")
    sys.exit(1)

new_handler = '''app.post("/twilio/inbound", (req, res) => {
  const payload = req.body || {};
  const fromPhone = payload.From || payload.from || "unknown";
  const ts = new Date().toISOString();

  // Always respond immediately to Twilio
  res.json({ ok: true });

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

'''

content = content[:start_idx] + new_handler + end_marker + content[end_idx + len(end_marker):]

with open("/Users/icl-agent/icl-twilio-intake/server.js", "w") as f:
    f.write(content)

print("Done. server.js patched.")
