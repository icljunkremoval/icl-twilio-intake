function evaluateQuoteReadyRow(row) {
  const hasMedia =
    Number(row.has_media) === 1 ||
    (row.num_media && Number(row.num_media) > 0) ||
    !!row.media_url0;

  const hasLoc = !!row.address_text || !!row.zip || !!row.zip_text;
  const hasAccess = !!row.access_level;
  const hasLoad = !!row.load_bucket;

  return hasMedia && hasLoc && hasAccess && hasLoad;
}

module.exports = { evaluateQuoteReadyRow };
