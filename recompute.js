const { pool } = require("./db");

async function recomputeDerived(from_phone) {
  const res = await pool.query("SELECT * FROM leads WHERE from_phone = $1", [from_phone]);
  const lead = res.rows[0] || null;
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

  await pool.query(`
    UPDATE leads
    SET has_media = $1,
        zip = COALESCE(zip, $2),
        quote_ready = $3,
        last_seen_at = NOW()
    WHERE from_phone = $4
  `, [has_media ? 1 : 0, zip, quote_ready ? 1 : 0, from_phone]);

  return { ok: true, has_media, zip, quote_ready };
}

module.exports = { recomputeDerived };
