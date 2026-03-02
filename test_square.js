const { createSquarePaymentLink } = require("./square_quote");

async function main() {
  const lead = { from_phone: "+13233979698" };
  try {
    const result = await createSquarePaymentLink(lead, 45000);
    console.log("SUCCESS:", JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("ERROR:", e.message);
  }
}

main();
