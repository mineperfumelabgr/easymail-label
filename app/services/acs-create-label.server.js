import {
  createAcsVoucher,
  extractAcsMultipartNumbers,
  extractAcsVoucherNo,
  getAcsMultipartVouchers,
  makeAcsLabelUrl,
  splitStreetAndNumber,
} from "./acs.server";

const NS = "acs";

const KEY_VOUCHER = "voucher_number";
const KEY_LABEL_URL = "label_url";
const KEY_CREATED_AT = "created_at";
const KEY_PIECES = "pieces";
const KEY_HISTORY = "voucher_history";
const KEY_CURRENT_NUMBERS = "current_numbers";
const KEY_CONTENT_TYPE = "content_type_id";
const KEY_PICKUP_DATE = "pickup_date";

function safeStr(v) {
  return String(v ?? "");
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function onlyDigits(v) {
  return safeStr(v).replace(/[^\d]/g, "");
}

function to2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

export function clampPieces(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(5, Math.floor(n)));
}

export function parseCodOverride(param) {
  if (param === null || param === undefined || param === "") return null;
  const v = String(param).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return null;
}

export function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

export function parsePickupDate(v) {
  const s = safeStr(v).trim();
  if (!s) return todayYMD();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error("Pickup date must be in YYYY-MM-DD format.");
  }
  return s;
}

export async function adminGraphql(admin, query, variables) {
  const r = await admin.graphql(query, { variables });
  const j = await r.json();
  if (j?.errors?.length) {
    const msg = j.errors.map((e) => e.message).join(" | ");
    throw new Error(`Shopify GraphQL error: ${msg}`);
  }
  return j;
}

export async function getAcsOrder(admin, orderGid) {
  const q = `#graphql
    query GetOrder($id: ID!) {
      order(id: $id) {
        id
        name
        tags
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress {
          name
          address1
          address2
          city
          province
          zip
          phone
          countryCodeV2
        }
        customer {
          firstName
          lastName
          phone
          email
        }
        fulfillments(first: 10) {
          id
          trackingInfo { company number url }
        }
        fulfillmentOrders(first: 10) {
          edges {
            node {
              id
              status
              lineItems(first: 100) {
                edges {
                  node {
                    id
                    remainingQuantity
                  }
                }
              }
            }
          }
        }
        metafields(first: 60, namespace: "${NS}") {
          edges { node { key value } }
        }
      }
    }
  `;
  const j = await adminGraphql(admin, q, { id: orderGid });
  return j?.data?.order || null;
}

function extractMetafields(order) {
  const edges = order?.metafields?.edges || [];
  const mfs = edges.map((e) => e.node);
  const get = (key) => mfs.find((m) => m.key === key)?.value || "";
  return { get };
}

function normalizeFulfillments(order) {
  const f = order?.fulfillments;
  if (!f) return [];
  if (Array.isArray(f)) return f.filter(Boolean);
  if (f?.edges) return (f.edges || []).map((e) => e?.node).filter(Boolean);
  return [];
}

async function setMetafields(admin, ownerId, items) {
  const m = `#graphql
    mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    metafields: items.map((it) => ({
      ownerId,
      namespace: NS,
      key: it.key,
      type: it.type,
      value: it.value,
    })),
  };
  const j = await adminGraphql(admin, m, variables);
  return j?.data?.metafieldsSet?.userErrors || [];
}

function getExistingTrackingNumbers(order) {
  const nums = [];
  for (const f of normalizeFulfillments(order)) {
    for (const ti of f?.trackingInfo || []) {
      if (ti?.number) nums.push(String(ti.number));
    }
  }
  return uniq(nums);
}

function makeAcsTrackingUrl(number) {
  return `https://webapp.acscourier.net/track-shipment/${number}`;
}

function buildAcsTrackingPayload(trackingNumbers) {
  const numbers = (trackingNumbers || []).filter(Boolean).map(String);
  const mainNumber = numbers[0] || null;

  return {
    company: "ACS Courier",
    number: mainNumber,
    url: mainNumber ? makeAcsTrackingUrl(mainNumber) : null,
  };
}

async function updateTrackingOnExistingFulfillment(admin, fulfillmentId, trackingNumbers) {
  const mutation = `#graphql
    mutation UpdateTracking(
      $fulfillmentId: ID!,
      $trackingInfoInput: FulfillmentTrackingInput!,
      $notifyCustomer: Boolean
    ) {
      fulfillmentTrackingInfoUpdateV2(
        fulfillmentId: $fulfillmentId
        trackingInfoInput: $trackingInfoInput
        notifyCustomer: $notifyCustomer
      ) {
        fulfillment { id }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    fulfillmentId,
    notifyCustomer: false,
trackingInfoInput: buildAcsTrackingPayload(trackingNumbers),
  };
  const j = await adminGraphql(admin, mutation, variables);
  return j?.data?.fulfillmentTrackingInfoUpdateV2?.userErrors || [];
}

async function createFulfillment(admin, fulfillmentOrderId, lineItems, trackingNumbers) {
  const mutation = `#graphql
    mutation CreateFulfillment($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment { id }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    fulfillment: {
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId,
          fulfillmentOrderLineItems: lineItems.map((li) => ({
            id: li.id,
            quantity: li.remainingQuantity,
          })),
        },
      ],
      notifyCustomer: true,
trackingInfo: buildAcsTrackingPayload(trackingNumbers),
    },
  };
  const j = await adminGraphql(admin, mutation, variables);
  return {
    errs: j?.data?.fulfillmentCreateV2?.userErrors || [],
    newId: j?.data?.fulfillmentCreateV2?.fulfillment?.id || null,
  };
}

export async function createOrReuseAcsLabel({
  admin,
  orderGid,
  forceNew = false,
  pieces = 1,
  codOverride = null,
  requestedContentTypeId = 7,
  requestedPickupDate,
}) {
  if (!process.env.ACS_BILLING_CODE) {
    throw new Error("Missing ACS_BILLING_CODE in environment.");
  }

  const order = await getAcsOrder(admin, orderGid);
  if (!order) {
    throw new Error("Order not found or access denied.");
  }

  const { get } = extractMetafields(order);

  const existingVoucher = safeStr(get(KEY_VOUCHER));
  const existingLabelUrl = safeStr(get(KEY_LABEL_URL));
  const existingCreatedAt = safeStr(get(KEY_CREATED_AT));
  const existingPieces = safeStr(get(KEY_PIECES));
  const existingCurrentNumbersRaw = safeStr(get(KEY_CURRENT_NUMBERS));
  const existingPickupDate = safeStr(get(KEY_PICKUP_DATE));

  if (existingVoucher && !forceNew) {
    let nums = [];
    if (existingCurrentNumbersRaw) {
      try {
        const parsed = JSON.parse(existingCurrentNumbersRaw);
        if (Array.isArray(parsed)) nums = parsed.map(String);
      } catch {}
    }
    if (!nums.length) nums = [String(existingVoucher)];

    const labels = uniq(nums).map((n) => ({ number: n, url: makeAcsLabelUrl(n) }));
    const masterUrl = existingLabelUrl || makeAcsLabelUrl(existingVoucher);

    const autoIsCOD = (order.tags || []).includes("COD");
    const orderTotal = to2(order?.currentTotalPriceSet?.shopMoney?.amount);

    return {
      success: true,
      exists: true,
      voucherNumber: existingVoucher,
      labelUrl: masterUrl,
      labels,
      shipmentNumbers: labels.map((l) => l.number),
      createdAtIso: existingCreatedAt || "",
      pieces: existingPieces || "1",
      pickupDate: existingPickupDate || requestedPickupDate,
      message: "An ACS label has already been generated for this order.",
      cod: { isCOD: autoIsCOD, orderTotal },
    };
  }

  const ship = order.shippingAddress || {};
  const customer = order.customer || {};

  const country = safeStr(ship.countryCodeV2 || "GR").toUpperCase();
  if (!["GR", "CY", "BG"].includes(country)) {
    throw new Error(
      `ACS label creation is currently supported only for GR,CY and BG destinations. Destination was: ${country || "UNKNOWN"}.`,
    );
  }

  const zip = safeStr(ship.zip);
  const zipDigits = Number(zip.replace(/[^\d]/g, ""));
  if (!zip) {
    throw new Error("Missing shipping ZIP / postal code.");
  }
  if (!zipDigits) {
    throw new Error(`Invalid shipping ZIP / postal code: ${zip}`);
  }

  const region = safeStr(ship.province) || safeStr(ship.city);
  if (!region) {
    throw new Error("Missing shipping city/region.");
  }

  const fullName =
    safeStr(ship.name) ||
    `${safeStr(customer.firstName)} ${safeStr(customer.lastName)}`.trim() ||
    "Customer";

  const { street, number } = splitStreetAndNumber(ship.address1);
  if (!street) {
    throw new Error("Missing shipping address line.");
  }

  const autoIsCOD = (order.tags || []).includes("COD");
  const isCOD = codOverride === null ? autoIsCOD : codOverride;

  const orderTotal = to2(order?.currentTotalPriceSet?.shopMoney?.amount);
  const codAmount = isCOD && orderTotal > 0 ? orderTotal : null;

  const phoneRaw = safeStr(ship.phone) || safeStr(customer.phone) || "";
  const phoneDigits = onlyDigits(phoneRaw);
  const phoneNumber = phoneDigits ? Number(phoneDigits) : null;
  const email = safeStr(customer.email) || null;

  const contentTypeId = country === "CY" ? requestedContentTypeId : null;

  const payload = {
    Pickup_Date: requestedPickupDate,
    Sender: process.env.ACS_SENDER_NAME || "MINE PERFUME LAB GR",
    Recipient_Name: fullName,
    Recipient_Address: street,
    Recipient_Address_Number: Number(number) || 1,
    Recipient_Zipcode: zipDigits,
    Recipient_Region: region,
    Recipient_Phone: phoneNumber,
    Recipient_Cell_Phone: phoneNumber,
    Recipient_Floor: null,
    Recipient_Company_Name: null,
    Recipient_Country: country,
    Acs_Station_Destination: null,
    Acs_Station_Branch_Destination: null,
    Billing_Code: process.env.ACS_BILLING_CODE,
    Charge_Type: 2,
    Cost_Center_Code: null,
    Item_Quantity: Number(pieces),
    Weight: 0.5,
    Dimension_X_In_Cm: null,
    Dimension_Y_in_Cm: null,
    Dimension_Z_in_Cm: null,
    Cod_Ammount: codAmount,
    Cod_Payment_Way: codAmount ? 0 : null,
    Acs_Delivery_Products: codAmount ? "COD" : null,
    Insurance_Ammount: null,
    Delivery_Notes: `Order ${order.name}`,
    Appointment_Until_Time: null,
    Recipient_Email: email,
    Reference_Key1: safeStr(order.name) || null,
    Reference_Key2: safeStr(order.name) || null,
    With_Return_Voucher: null,
    Content_Type_ID: contentTypeId,
    Language: "GR",
  };

  console.log("ACS CREATE PAYLOAD:");
  console.dir(payload, { depth: 10 });

  const createResp = await createAcsVoucher(payload);
  const masterVoucherNumber = extractAcsVoucherNo(createResp);

  if (!masterVoucherNumber) {
    throw new Error("ACS did not return Voucher_No.");
  }

  let childNumbers = [];
  if (Number(pieces) > 1) {
    try {
      const multiResp = await getAcsMultipartVouchers(masterVoucherNumber);
      childNumbers = extractAcsMultipartNumbers(multiResp);
    } catch (e) {
      console.warn("ACS multipart warning:", e?.message || e);
    }
  }

  const numbersOrdered = uniq([String(masterVoucherNumber), ...childNumbers]);
  const labels = numbersOrdered.map((n) => ({ number: n, url: makeAcsLabelUrl(n) }));
  const masterLabelUrl = makeAcsLabelUrl(masterVoucherNumber);

  let history = [];
  const historyRaw = safeStr(get(KEY_HISTORY));
  if (historyRaw) {
    try {
      const parsed = JSON.parse(historyRaw);
      if (Array.isArray(parsed)) history = parsed;
    } catch {}
  }

  if (existingVoucher && existingVoucher !== String(masterVoucherNumber)) {
    history.unshift({
      voucherNumber: existingVoucher,
      labelUrl: existingLabelUrl || makeAcsLabelUrl(existingVoucher),
      createdAtIso: existingCreatedAt || null,
      pieces: existingPieces || null,
      pickupDate: existingPickupDate || null,
      shipmentNumbers: (() => {
        try {
          const parsed = JSON.parse(existingCurrentNumbersRaw || "[]");
          return Array.isArray(parsed) ? parsed.map(String) : null;
        } catch {
          return null;
        }
      })(),
    });
    history = history.slice(0, 20);
  }

  history.unshift({
    voucherNumber: String(masterVoucherNumber),
    labelUrl: masterLabelUrl,
    createdAtIso: new Date().toISOString(),
    pieces: String(pieces),
    pickupDate: requestedPickupDate,
    shipmentNumbers: numbersOrdered,
    contentTypeId,
  });
  history = history.slice(0, 20);

  const metafieldsToSave = [
    { key: KEY_VOUCHER, type: "single_line_text_field", value: String(masterVoucherNumber) },
    { key: KEY_LABEL_URL, type: "single_line_text_field", value: String(masterLabelUrl) },
    { key: KEY_CREATED_AT, type: "single_line_text_field", value: new Date().toISOString() },
    { key: KEY_PIECES, type: "single_line_text_field", value: String(pieces) },
    { key: KEY_PICKUP_DATE, type: "single_line_text_field", value: String(requestedPickupDate) },
    { key: KEY_CURRENT_NUMBERS, type: "json", value: JSON.stringify(numbersOrdered) },
    { key: KEY_HISTORY, type: "json", value: JSON.stringify(history) },
  ];

  if (contentTypeId) {
    metafieldsToSave.push({
      key: KEY_CONTENT_TYPE,
      type: "single_line_text_field",
      value: String(contentTypeId),
    });
  }

  const mfErrors = await setMetafields(admin, order.id, metafieldsToSave);

  if (mfErrors.length) {
    console.log("ACS METAFIELD ERRORS:");
    console.dir(mfErrors, { depth: 10 });
  }

  const existingTracking = getExistingTrackingNumbers(order);
  const mergedTracking = uniq([...existingTracking, ...numbersOrdered]);

  let fulfillmentCreated = false;
  let fulfillmentWarning = null;

  const fulfillments = normalizeFulfillments(order);
  const firstFulfillmentId = fulfillments?.[0]?.id || null;

  if (firstFulfillmentId) {
    const errs = await updateTrackingOnExistingFulfillment(admin, firstFulfillmentId, mergedTracking);
    if (errs.length) fulfillmentWarning = errs.map((e) => e.message).join(" | ");
  } else {
    const foEdges = order?.fulfillmentOrders?.edges || [];
    const openFO = foEdges.find((e) => e?.node?.status !== "CLOSED")?.node;

    const lineItems =
      openFO?.lineItems?.edges
        ?.map((x) => x?.node)
        ?.filter((li) => (li?.remainingQuantity || 0) > 0) || [];

    if (!openFO || lineItems.length === 0) {
      fulfillmentWarning =
        "Label created, but there are no fulfillable items (fulfillment orders missing/closed or remainingQuantity = 0).";
    } else {
      const { errs } = await createFulfillment(admin, openFO.id, lineItems, mergedTracking);
      if (errs.length) fulfillmentWarning = errs.map((e) => e.message).join(" | ");
      else fulfillmentCreated = true;
    }
  }

  const mfWarn = mfErrors.length
    ? `Metafields warnings: ${mfErrors.map((e) => e.message).join(" | ")}`
    : "";

  const fulfMsg = fulfillmentWarning
    ? `Fulfillment: NOT created/updated (${fulfillmentWarning}).`
    : fulfillmentCreated
    ? "Fulfillment: created and tracking added."
    : "Fulfillment: tracking updated.";

  return {
    success: true,
    exists: false,
    voucherNumber: String(masterVoucherNumber),
    labelUrl: masterLabelUrl,
    labels,
    shipmentNumbers: numbersOrdered,
    pickupDate: requestedPickupDate,
    message: `ACS label generated. Pickup: ${requestedPickupDate} • Master: ${masterVoucherNumber} • Pieces: ${pieces} • Labels: ${numbersOrdered.length} • ${fulfMsg}${mfWarn ? " " + mfWarn : ""}`,
    cod: {
      autoIsCOD,
      isCOD,
      override: codOverride,
      orderTotal,
      codAmount,
    },
    destinationCountry: country,
    contentTypeId,
  };
}
