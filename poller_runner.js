const { pollOnce } = require("./deposit_poller");

const INTERVAL_MS = 90 * 1000;

async function tick() {
  try {
    const r = await pollOnce();
    console.log(`[deposit_poller] checked=${r.checked} at=${new Date().toISOString()}`);
  } catch (e) {
    console.error(`[deposit_poller] error=${e?.message || e}`);
  }
}

tick();
setInterval(tick, INTERVAL_MS);
