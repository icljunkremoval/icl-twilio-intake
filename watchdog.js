#!/usr/bin/env node

// ICL Intake Watchdog
// Runs every 5 minutes via PM2
// Checks /health endpoint, restarts tunnel if down, texts your cell if still down

const { execSync } = require("child_process");
const fetch = require("node-fetch");

const HEALTH_URL = "https://intake.icljunkremoval.com/health";
const LOCAL_HEALTH_URL = "http://127.0.0.1:8788/health";
const ALERT_PHONE = process.env.WATCHDOG_ALERT_PHONE; // your personal cell
const PM2 = "/opt/homebrew/bin/pm2";
const CHECK_INTERVAL_MS = 60 * 1000; // 5 minutes

let consecutiveFailures = 0;

async function checkHealth() {
  const ts = new Date().toISOString();

  // Check public endpoint
  try {
    const res = await fetch(HEALTH_URL, { timeout: 10000 });
    if (res.ok) {
      consecutiveFailures = 0;
      console.log(`[watchdog] OK ${ts}`);
      return;
    }
  } catch (e) {
    console.log(`[watchdog] Public health failed: ${e.message}`);
  }

  consecutiveFailures++;
  console.log(`[watchdog] FAIL #${consecutiveFailures} at ${ts}`);

  // Check if local server is up
  let localUp = false;
  try {
    const res = await fetch(LOCAL_HEALTH_URL, { timeout: 5000 });
    localUp = res.ok;
  } catch (e) {}

  if (!localUp) {
    // Server is down — restart it
    console.log("[watchdog] Local server down — restarting icl-twilio-intake");
    try { execSync(`${PM2} restart icl-twilio-intake --update-env`); } catch (e) {}
    await sleep(3000);
  }

  // Always restart tunnel on public failure
  console.log("[watchdog] Restarting tunnel");
  try { execSync(`${PM2} restart cf-tunnel-intake`); } catch (e) {}
  await sleep(5000);

  // Check again
  try {
    const res = await fetch(HEALTH_URL, { timeout: 10000 });
    if (res.ok) {
      console.log("[watchdog] Recovered after restart");
      consecutiveFailures = 0;

      // Alert that it was down but recovered
      if (ALERT_PHONE) {
        await sendAlert(`ICL Intake was down but recovered at ${ts}. Auto-restarted.`);
      }
      return;
    }
  } catch (e) {}

  // Still down after restart — send alert
  console.log("[watchdog] Still down after restart — sending alert");
  if (ALERT_PHONE) {
    await sendAlert(`ALERT: ICL Intake is DOWN. Auto-restart failed. Check the Old Mac immediately. ${ts}`);
  }
}

async function sendAlert(message) {
  if (!ALERT_PHONE) return;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.log("[watchdog] Missing Twilio env — cannot send alert");
    return;
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          To: ALERT_PHONE,
          From: fromNumber,
          Body: message
        }).toString()
      }
    );
    const data = await res.json();
    console.log("[watchdog] Alert sent:", data.sid);
  } catch (e) {
    console.log("[watchdog] Alert failed:", e.message);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Run immediately then on interval
checkHealth();
setInterval(checkHealth, CHECK_INTERVAL_MS);
