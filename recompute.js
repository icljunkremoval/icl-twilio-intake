const { db } = require("./db");

function recomputeDerived(from_phone) {
  // Pull current snapshot
  const lead = db.prepare("SELECT * FROM leads WHERE from_phone = ?").get(from_phone);
  if (!lead) return { ok: false, reason: "no_lead" };

  const has_media =
    Number(lead.has_media) === 1 ||
    (lead.num_media != null && Number(lead.num_media) > 0) ||
    !!lead.media_url0;

  const zip = lead.zip || lead.zip_text || null;
  const has_loc = !!lead.address_text || !!zip;
  const has_access = !!lead.access_level;
  const has_load = !!lead.load_bucket;

  const quote_ready = has_media && has_loc && has_access && has_load;

  db.prepare(`
    UPDATE leads
    SET has_media = ?,
        zip = COALESCE(zip, ?),
        quote_ready = ?,
        last_seen_at = datetime('now')
    WHERE from_phone = ?
  `).run(has_media ? 1 : 0, zip, quote_ready ? 1 : 0, from_phone);

  return { ok: true, has_media, zip, quote_ready };
}

module.exports = { recomputeDerived };
