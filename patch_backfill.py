with open("/Users/icl-agent/icl-twilio-intake/conversation.js", "r") as f:
    content = f.read()

# Add backfill require
old_require = 'const { analyzeJobMedia } = require("./vision_analyzer");'
new_require = '''const { analyzeJobMedia } = require("./vision_analyzer");
const { backfillLatestMedia } = require("./twilio_media_backfill");'''

if 'twilio_media_backfill' not in content:
    content = content.replace(old_require, new_require)
    print("Added backfill require")
else:
    print("backfill require already present")

# Add backfill logic in the NEW/AWAITING_MEDIA state when no media arrives
old_no_media = '''      } else {
        // No media yet — ask for it
        db.prepare(`UPDATE leads SET conv_state = ?, last_seen_at = datetime('now') WHERE from_phone = ?`).run(STATES.AWAITING_MEDIA, from_phone);

        await sendSms(from_phone,
          "Hi! Thanks for contacting ICL Junk Removal.\\n\\nTo give you an upfront quote, please send a photo (or short video) of what you need removed."
        );
      }
      break;
    }'''

new_no_media = '''      } else {
        // No media in payload — try backfill from Twilio API
        db.prepare(`UPDATE leads SET conv_state = ?, last_seen_at = datetime('now') WHERE from_phone = ?`).run(STATES.AWAITING_MEDIA, from_phone);

        // Attempt backfill silently
        backfillLatestMedia({ from: from_phone, maxAgeSeconds: 120 }).then((b) => {
          if (b && b.mediaUrl0) {
            // Got media via backfill — update lead and process
            try {
              db.prepare(`UPDATE leads SET has_media = 1, num_media = ?, media_url0 = ?, conv_state = ?, last_seen_at = datetime('now') WHERE from_phone = ?`)
                .run(b.numMedia, b.mediaUrl0, STATES.AWAITING_HAZMAT, from_phone);
            } catch (e) {}

            logEvent(from_phone, "media_backfill_hit", b);

            sendSms(from_phone, "Got it — analyzing your photo now...").catch(() => {});

            // Run vision analysis
            analyzeJobMedia(b.mediaUrl0).then((vision) => {
              logEvent(from_phone, "vision_analysis", vision);
              db.prepare(`UPDATE leads SET vision_analysis = ?, troll_flag = ?, crew_notes = ?, item_tags = ?, last_seen_at = datetime('now') WHERE from_phone = ?`)
                .run(JSON.stringify(vision), vision.troll_flag ? 1 : 0, vision.crew_notes || null, JSON.stringify(vision.data_tags || []), from_phone);

              if (vision.troll_flag || !vision.is_valid_junk) {
                db.prepare(`UPDATE leads SET conv_state = ?, last_seen_at = datetime('now') WHERE from_phone = ?`).run(STATES.ESCALATED, from_phone);
                sendSms(from_phone, "Thanks for reaching out! We weren't able to identify junk removal items. Reply with a clear photo of what needs removal, or reply HELP to reach our team.").catch(() => {});
                return;
              }

              // Pre-fill from vision if high confidence
              let updates = [];
              let params = [];
              if (vision.load_bucket && vision.load_confidence === "HIGH") {
                updates.push("load_bucket = ?"); params.push(vision.load_bucket);
              }
              if (vision.access_level && vision.access_level !== "UNKNOWN" && vision.access_confidence === "HIGH") {
                updates.push("access_level = ?"); params.push(vision.access_level);
              }
              if (updates.length > 0) {
                params.push(from_phone);
                db.prepare("UPDATE leads SET " + updates.join(", ") + ", last_seen_at = datetime('now') WHERE from_phone = ?").run(...params);
              }

            }).catch((e) => { logEvent(from_phone, "vision_error", { error: String(e.message || e) }); });

            sendSms(from_phone, "Quick question: do any items include restricted materials like paint, chemicals, fuel, batteries, asbestos, or medical waste?\\n\\nReply YES or NO").catch(() => {});
          } else {
            // No media found — ask for it
            sendSms(from_phone, "Hi! Thanks for contacting ICL Junk Removal.\\n\\nTo give you an upfront quote, please send a photo (or short video) of what you need removed.").catch(() => {});
          }
        }).catch(() => {
          sendSms(from_phone, "Hi! Thanks for contacting ICL Junk Removal.\\n\\nTo give you an upfront quote, please send a photo (or short video) of what you need removed.").catch(() => {});
        });
      }
      break;
    }'''

if old_no_media in content:
    content = content.replace(old_no_media, new_no_media)
    print("Patched no-media block with backfill")
else:
    print("ERROR: Could not find no-media block")

with open("/Users/icl-agent/icl-twilio-intake/conversation.js", "w") as f:
    f.write(content)

print("Done.")
