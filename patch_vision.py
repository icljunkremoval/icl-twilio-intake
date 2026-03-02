with open("/Users/icl-agent/icl-twilio-intake/conversation.js", "r") as f:
    content = f.read()

# Add vision_analyzer require
old_require = 'const { maybeCreateQuote } = require("./quote_worker");'
new_require = '''const { maybeCreateQuote } = require("./quote_worker");
const { analyzeJobMedia } = require("./vision_analyzer");'''

if 'vision_analyzer' not in content:
    content = content.replace(old_require, new_require)
    print("Added vision_analyzer require")

# Replace the media received block in AWAITING_MEDIA/NEW state
old_media_block = '''      if (numMedia > 0 || mediaUrl) {
        // Got media — save and move to hazmat
        try {
          upsertLead.run({
            from_phone,
            to_phone,
            ts: new Date().toISOString(),
            last_event: "media_received",
            last_body: body,
            num_media: numMedia,
            media_url0: mediaUrl || null,
          });
        } catch (e) {}

        logEvent(from_phone, "media_received", { numMedia, mediaUrl });
        db.prepare(`UPDATE leads SET conv_state = ?, has_media = 1, last_seen_at = datetime('now') WHERE from_phone = ?`).run(STATES.AWAITING_HAZMAT, from_phone);

        await sendSms(from_phone,
          "Got it — thanks.\\n\\nQuick question: do any items include restricted materials like paint, chemicals, fuel, batteries, asbestos, or medical waste?\\n\\nReply YES or NO"
        );'''

new_media_block = '''      if (numMedia > 0 || mediaUrl) {
        // Got media — save
        try {
          upsertLead.run({
            from_phone,
            to_phone,
            ts: new Date().toISOString(),
            last_event: "media_received",
            last_body: body,
            num_media: numMedia,
            media_url0: mediaUrl || null,
          });
        } catch (e) {}

        logEvent(from_phone, "media_received", { numMedia, mediaUrl });
        db.prepare(`UPDATE leads SET conv_state = ?, has_media = 1, last_seen_at = datetime('now') WHERE from_phone = ?`).run(STATES.AWAITING_HAZMAT, from_phone);

        await sendSms(from_phone, "Got it — analyzing your photo now...");

        // Run vision analysis async
        if (mediaUrl) {
          analyzeJobMedia(mediaUrl).then((vision) => {
            logEvent(from_phone, "vision_analysis", vision);

            // Store vision results
            db.prepare(`UPDATE leads SET
              vision_analysis = ?,
              troll_flag = ?,
              crew_notes = ?,
              item_tags = ?,
              last_seen_at = datetime('now')
              WHERE from_phone = ?`
            ).run(
              JSON.stringify(vision),
              vision.troll_flag ? 1 : 0,
              vision.crew_notes || null,
              JSON.stringify(vision.data_tags || []),
              from_phone
            );

            // If troll, escalate
            if (vision.troll_flag || !vision.is_valid_junk) {
              db.prepare(`UPDATE leads SET conv_state = ?, last_seen_at = datetime('now') WHERE from_phone = ?`).run(STATES.ESCALATED, from_phone);
              sendSms(from_phone, "Thanks for reaching out! We weren't able to identify junk removal items in your photo. Reply with a clear photo of what you need removed, or reply HELP to reach our team.").catch(() => {});
              return;
            }

            // Pre-fill load and access if high confidence
            let updates = [];
            let params = [];
            if (vision.load_bucket && vision.load_confidence === "HIGH") {
              updates.push("load_bucket = ?");
              params.push(vision.load_bucket);
              logEvent(from_phone, "vision_load_set", { load_bucket: vision.load_bucket });
            }
            if (vision.access_level && vision.access_level !== "UNKNOWN" && vision.access_confidence === "HIGH") {
              updates.push("access_level = ?");
              params.push(vision.access_level);
              logEvent(from_phone, "vision_access_set", { access_level: vision.access_level });
            }
            if (updates.length > 0) {
              params.push(from_phone);
              db.prepare("UPDATE leads SET " + updates.join(", ") + ", last_seen_at = datetime('now') WHERE from_phone = ?").run(...params);
            }

          }).catch((e) => {
            logEvent(from_phone, "vision_error", { error: String(e.message || e) });
          });
        }

        await sendSms(from_phone,
          "Got it — thanks.\\n\\nQuick question: do any items include restricted materials like paint, chemicals, fuel, batteries, asbestos, or medical waste?\\n\\nReply YES or NO"
        );'''

if old_media_block in content:
    content = content.replace(old_media_block, new_media_block)
    print("Patched media block with vision analysis")
else:
    print("ERROR: Could not find media block to patch")

with open("/Users/icl-agent/icl-twilio-intake/conversation.js", "w") as f:
    f.write(content)

print("Done.")
