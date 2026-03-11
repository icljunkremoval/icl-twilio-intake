const { pool, insertEvent } = require("./db");

function intOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function dollarsToCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

async function refreshMarginForLead(fromPhone) {
  const row = (
    await pool.query(
      `SELECT
         settled_revenue_cents,
         labor_cost_cents,
         disposal_cost_cents,
         fuel_cost_cents,
         other_cost_cents,
         salvage_actual_value
       FROM leads
       WHERE from_phone = $1`,
      [fromPhone]
    )
  ).rows[0];
  if (!row) return null;
  const revenue = intOrNull(row.settled_revenue_cents) || 0;
  const labor = intOrNull(row.labor_cost_cents) || 0;
  const disposal = intOrNull(row.disposal_cost_cents) || 0;
  const fuel = intOrNull(row.fuel_cost_cents) || 0;
  const other = intOrNull(row.other_cost_cents) || 0;
  const salvage = intOrNull(row.salvage_actual_value) || 0;
  const totalCosts = labor + disposal + fuel + other;
  const margin = revenue + salvage - totalCosts;
  const marginPct = revenue > 0 ? Number(((margin / revenue) * 100).toFixed(1)) : null;

  await pool.query(
    `UPDATE leads
     SET total_cost_cents = $1,
         margin_cents = $2,
         margin_pct = $3,
         margin_refreshed_at = NOW(),
         last_seen_at = NOW()
     WHERE from_phone = $4`,
    [totalCosts, margin, marginPct, fromPhone]
  );

  return { revenue, totalCosts, margin, marginPct };
}

async function recordSettledRevenue(fromPhone, payment) {
  const amountCents = intOrNull(payment?.amountCents);
  if (!amountCents || amountCents <= 0) return null;
  const settledAt = payment?.settledAt ? String(payment.settledAt) : new Date().toISOString();
  await pool.query(
    `UPDATE leads
     SET square_payment_id = COALESCE($1, square_payment_id),
         settled_revenue_cents = COALESCE(settled_revenue_cents, 0) + $2,
         square_settled_at = $3,
         last_seen_at = NOW()
     WHERE from_phone = $4`,
    [payment?.paymentId || null, amountCents, settledAt, fromPhone]
  );
  const margin = await refreshMarginForLead(fromPhone);
  try {
    insertEvent.run({
      from_phone: fromPhone,
      event_type: "settled_revenue_ingested",
      payload_json: JSON.stringify({
        payment_id: payment?.paymentId || null,
        order_id: payment?.orderId || null,
        amount_cents: amountCents,
        settled_at: settledAt,
        margin
      }),
      created_at: new Date().toISOString()
    });
  } catch {}
  return { amountCents, margin };
}

async function recordJobCosts(fromPhone, costs = {}, source = "manual") {
  const labor = costs?.labor_cents ?? costs?.laborCostCents ?? dollarsToCents(costs?.labor_dollars ?? costs?.labor);
  const disposal = costs?.disposal_cents ?? costs?.disposalCostCents ?? dollarsToCents(costs?.disposal_dollars ?? costs?.disposal);
  const fuel = costs?.fuel_cents ?? costs?.fuelCostCents ?? dollarsToCents(costs?.fuel_dollars ?? costs?.fuel);
  const other = costs?.other_cents ?? costs?.otherCostCents ?? dollarsToCents(costs?.other_dollars ?? costs?.other);
  await pool.query(
    `UPDATE leads
     SET labor_cost_cents = COALESCE($1, labor_cost_cents),
         disposal_cost_cents = COALESCE($2, disposal_cost_cents),
         fuel_cost_cents = COALESCE($3, fuel_cost_cents),
         other_cost_cents = COALESCE($4, other_cost_cents),
         last_seen_at = NOW()
     WHERE from_phone = $5`,
    [intOrNull(labor), intOrNull(disposal), intOrNull(fuel), intOrNull(other), fromPhone]
  );
  const margin = await refreshMarginForLead(fromPhone);
  try {
    insertEvent.run({
      from_phone: fromPhone,
      event_type: "job_costs_ingested",
      payload_json: JSON.stringify({
        source,
        labor_cents: intOrNull(labor),
        disposal_cents: intOrNull(disposal),
        fuel_cents: intOrNull(fuel),
        other_cents: intOrNull(other),
        margin
      }),
      created_at: new Date().toISOString()
    });
  } catch {}
  return margin;
}

module.exports = { refreshMarginForLead, recordSettledRevenue, recordJobCosts };
