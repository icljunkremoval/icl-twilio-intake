const { db, insertEvent } = require("./db");
const { jobberGraphQL } = require("./jobber_client");
const { sendSms } = require("./twilio_sms");

const POLL_LIMIT = 25;          // max leads per cycle
const DEPOSIT_MIN = 50.0;       // dollars
const STATUS_AWAIT = "AWAITING_DEPOSIT";
const STATUS_PAID = "DEPOSIT_PAID";
const STATUS_BOOKING_SENT = "BOOKING_SENT";

function buildWindowPickerSms() {
  return `Deposit received ✅ Reply with your arrival window:\n1) 9–11\n2) 12–2\n3) 3–5`;
}

async function fetchDepositStatus(quoteId) {
  const data = await jobberGraphQL({
    query: `
      query($id: EncodedId!) {
        quote(id: $id) {
          id
          quoteStatus
          unallocatedDepositRecords {
            totalCount
            nodes {
              amount
              jobberPaymentTransactionStatus
            }
          }
        }
      }
    `,
    variables: { id: quoteId },
  });

  const q = data.quote;
  const nodes = q?.unallocatedDepositRecords?.nodes || [];
  const succeeded = nodes.filter(n =>
    n &&
    Number(n.amount || 0) >= (DEPOSIT_MIN - 0.01) &&
    String(n.jobberPaymentTransactionStatus || "").toUpperCase() === "SUCCEEDED"
  );

  return { hasDeposit: succeeded.length > 0, depositCount: succeeded.length, nodes };
}

function markPaid(from_phone, details) {
  db.prepare(`
    UPDATE leads
    SET quote_status = ?,
        last_error = NULL,
        last_seen_at = datetime(now)
    WHERE from_phone = ?
  `).run(STATUS_PAID, from_phone);

  try {
    insertEvent.run({
      from_phone,
      event_type: "deposit_detected",
      payload_json: JSON.stringify(details || {}),
      created_at: new Date().toISOString(),
    });
  } catch {}
}

function markBookingSent(from_phone) {
  db.prepare(`
    UPDATE leads
    SET quote_status = ?,
        last_error = NULL,
        last_seen_at = datetime(now)
    WHERE from_phone = ?
  `).run(STATUS_BOOKING_SENT, from_phone);
}

async function processOneLead(lead) {
  if (!lead.jobber_quote_id) return;

  const st = await fetchDepositStatus(lead.jobber_quote_id);
  if (!st.hasDeposit) return;

  markPaid(lead.from_phone, { jobber_quote_id: lead.jobber_quote_id, deposit_nodes: st.nodes });

  // Send window picker SMS
  const sms = await sendSms(lead.from_phone, buildWindowPickerSms());
  try {
    insertEvent.run({
      from_phone: lead.from_phone,
      event_type: "sms_sent_window_picker",
      payload_json: JSON.stringify({ template: "WINDOW_PICK_V1", twilio: sms }),
      created_at: new Date().toISOString(),
    });
  } catch {}

  markBookingSent(lead.from_phone);
}

async function pollOnce() {
  const leads = db.prepare(`
    SELECT from_phone, jobber_quote_id, quote_status
    FROM leads
    WHERE quote_status = ?
      AND jobber_quote_id IS NOT NULL
    ORDER BY last_seen_at DESC
    LIMIT ?
  `).all(STATUS_AWAIT, POLL_LIMIT);

  for (const lead of leads) {
    try {
      await processOneLead(lead);
    } catch (e) {
      // Do not change status on poll error; just log
      try {
        insertEvent.run({
          from_phone: lead.from_phone,
          event_type: "deposit_poll_error",
          payload_json: JSON.stringify({ error: String(e?.message || e) }),
          created_at: new Date().toISOString(),
        });
      } catch {}
    }
  }

  return { checked: leads.length };
}

module.exports = { pollOnce };
