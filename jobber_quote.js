const { jobberGraphQL } = require("./jobber_client");

const DEPOSIT_CENTS = 5000;

// Helper: cents -> float dollars (Jobber uses Float for money fields)
function centsToDollars(cents) {
  return Math.round(Number(cents || 0)) / 100;
}

function makePropertyAddress(lead) {
  const zip = lead.zip || lead.zip_text || "";
  const addressText = lead.address_text || "";

  // AddressAttributes fields (from schema) typically accept: street1, city, region, postalCode, country
  if (addressText && addressText.length > 5) {
    return {
      street1: addressText,
      city: "Inglewood",
      province: "CA",
      postalCode: zip || "90302",
      country: "US",
    };
  }
  return {
    street1: "ZIP-only estimate",
    city: "Inglewood",
    province: "CA",
    postalCode: zip || "90302",
    country: "US",
  };
}

async function clientCreate(from_phone) {
  const data = await jobberGraphQL({
    query: `
      mutation($input: ClientCreateInput!) {
        clientCreate(input: $input) {
          client { id }
          userErrors { message }
        }
      }
    `,
    variables: {
      input: {
        isCompany: false,
        firstName: "ICL",
        lastName: "Customer",
        phones: [
          {
            number: from_phone,
            smsAllowed: true,
            primary: true,
          },
        ],
      },
    },
  });

  const errs = data.clientCreate.userErrors || [];
  if (errs.length) throw new Error(`clientCreate userErrors: ${JSON.stringify(errs)}`);
  return data.clientCreate.client.id;
}

async function propertyCreate(clientId, lead) {
  const data = await jobberGraphQL({
    query: `
      mutation($clientId: EncodedId!, $input: PropertyCreateInput!) {
        propertyCreate(clientId: $clientId, input: $input) {
          properties { id }
          userErrors { message }
        }
      }
    `,
    variables: {
      clientId,
      input: {
        properties: [
          {
            address: makePropertyAddress(lead),
            name: "Service Location",
          },
        ],
      },
    },
  });

  const errs = data.propertyCreate.userErrors || [];
  if (errs.length) throw new Error(`propertyCreate userErrors: ${JSON.stringify(errs)}`);

  const props = data.propertyCreate.properties || [];
  if (!props.length) throw new Error("propertyCreate returned no properties");
  return props[0].id;
}

async function requestCreate(clientId, propertyId) {
  // RequestDetailsInput requires a form; we avoid it by using title only (allowed by schema).
  const data = await jobberGraphQL({
    query: `
      mutation($input: RequestCreateInput!) {
        requestCreate(input: $input) {
          request { id }
          userErrors { message }
        }
      }
    `,
    variables: {
      input: {
        clientId,
        propertyId,
        title: "Junk Removal Request",
      },
    },
  });

  const errs = data.requestCreate.userErrors || [];
  if (errs.length) throw new Error(`requestCreate userErrors: ${JSON.stringify(errs)}`);
  return data.requestCreate.request.id;
}

async function quoteCreate({ clientId, propertyId, requestId, total_cents }) {
  const unitPrice = centsToDollars(total_cents);

  const data = await jobberGraphQL({
    query: `
      mutation($attributes: QuoteCreateAttributes!) {
        quoteCreate(attributes: $attributes) {
          quote {
            id
            clientHubUri
            jobberWebUri
            quoteStatus
          }
          userErrors { message }
        }
      }
    `,
    variables: {
      attributes: {
        title: "ICL Junk Removal — Upfront Quote",
        message:
          "Upfront quote from photos. To lock your arrival window, place the $50 deposit. Then you’ll pick 9–11, 12–2, or 3–5.",
        allowClientHubCreditCardPayments: true,
        allowClientHubAchPayments: false,
        mandatoryPaymentMethodOnFile: false,
        deposit: { type: "Unit", rate: centsToDollars(DEPOSIT_CENTS) },
        clientId,
        propertyId,
        requestId,
        transitionQuoteTo: "AWAITING_RESPONSE",
        lineItems: [
          {
            name: "Junk Removal (All-in)",
            description:
              "Labor + haul-away. Exceptions only for hazmat/special items and distance beyond included radius.",
            quantity: 1,
            unitPrice,
            saveToProductsAndServices: false,
          },
        ],
      },
    },
  });

  const errs = data.quoteCreate.userErrors || [];
  if (errs.length) throw new Error(`quoteCreate userErrors: ${JSON.stringify(errs)}`);

  const q = data.quoteCreate.quote;
  if (!q?.id) throw new Error("quoteCreate returned no quote.id");

  const link = q.clientHubUri || q.jobberWebUri;
  if (!link) throw new Error("quoteCreate returned no clientHubUri/jobberWebUri");

  return { quote_id: q.id, client_hub_uri: link, quote_status: q.quoteStatus };
}

async function createQuoteForLead(lead, total_cents) {
  // v1: create new objects each time (upsert comes later)
  const clientId = await clientCreate(lead.from_phone);
  const propertyId = await propertyCreate(clientId, lead);
  const requestId = await requestCreate(clientId, propertyId);
  const quote = await quoteCreate({ clientId, propertyId, requestId, total_cents });

  return { clientId, propertyId, requestId, ...quote };
}

module.exports = { createQuoteForLead };
