const nodemailer = require("nodemailer");

const PARTNER_EMAIL_REALTOR_ASSIST = String(process.env.PARTNER_EMAIL_REALTOR_ASSIST || "support@realtorassistca.com").trim();
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "").trim();
const FROM_EMAIL = String(process.env.SMTP_FROM || "admin@icljunkremoval.com").trim();

let transporterCache = null;

function hasSmtpConfig() {
  return Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS);
}

function getTransporter() {
  if (transporterCache) return transporterCache;
  if (!hasSmtpConfig()) return null;
  transporterCache = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  return transporterCache;
}

async function notifyRealtorAssist(lead) {
  try {
    const transporter = getTransporter();
    if (!transporter) {
      return { ok: false, reason: "smtp_not_configured" };
    }
    const subjectAnchor = String(lead?.address_text || lead?.from_phone || "new lead");
    const sentAt = new Date().toISOString();
    const body = [
      "A new referred lead has been received by ICL Junk Removal.",
      "",
      `Phone: ${String(lead?.from_phone || "unknown")}`,
      `Address: ${String(lead?.address_text || "address pending")}`,
      `Agent: ${String(lead?.referral_agent_name || "not provided")}`,
      `Received: ${sentAt}`,
      "",
      "This lead is being processed through the ICL intake system.",
      "Revenue share will be calculated per the Referral Partnership Agreement (Section 3).",
      "",
      "— ICL Junk Removal Automated Notification",
    ].join("\n");

    await transporter.sendMail({
      to: PARTNER_EMAIL_REALTOR_ASSIST,
      from: FROM_EMAIL,
      subject: `New ICL Referral Lead — ${subjectAnchor}`,
      text: body,
    });
    return { ok: true, sent_at: sentAt };
  } catch (e) {
    return { ok: false, reason: "send_failed", error: String(e?.message || e) };
  }
}

async function retryPendingRealtorAssistNotifications(pool, insertEvent) {
  if (!pool) return { ok: false, retried: 0, sent: 0 };
  try {
    const rows = (
      await pool.query(
        `SELECT from_phone, address_text, referral_agent_name, referral_partner, referral_notified_at
         FROM leads
         WHERE referral_partner = 'realtor_assist'
           AND referral_notified_at IS NULL
         ORDER BY last_seen_at DESC
         LIMIT 50`
      )
    ).rows || [];
    let sent = 0;
    for (const lead of rows) {
      const result = await notifyRealtorAssist(lead);
      if (result.ok) {
        sent += 1;
        await pool.query(
          "UPDATE leads SET referral_notified_at = COALESCE($1, NOW()::text), last_seen_at = NOW() WHERE from_phone = $2",
          [result.sent_at || new Date().toISOString(), lead.from_phone]
        );
        if (insertEvent && typeof insertEvent.run === "function") {
          try {
            insertEvent.run({
              from_phone: lead.from_phone,
              event_type: "referral_partner_notified",
              payload_json: JSON.stringify({ partner: "realtor_assist", via: "startup_retry" }),
              created_at: new Date().toISOString(),
            });
          } catch (_) {}
        }
      }
    }
    return { ok: true, retried: rows.length, sent };
  } catch (e) {
    return { ok: false, retried: 0, sent: 0, error: String(e?.message || e) };
  }
}

module.exports = {
  notifyRealtorAssist,
  retryPendingRealtorAssistNotifications,
};
