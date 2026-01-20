import { authenticate } from "../shopify.server";

const NS = "easymail";

const KEY_VOUCHER = "voucher_number"; // master
const KEY_LABEL_URL = "label_url"; // master pdf url
const KEY_CREATED_AT = "created_at";
const KEY_PIECES = "pieces";
const KEY_HISTORY = "voucher_history"; // JSON array, max 20
const KEY_CURRENT_NUMBERS = "current_numbers"; // JSON array of current shipment numbers (master + children)

const ESM_INSERT_VOUCHER =
  "https://webservices.easy-mail.gr/WcfServiceJSON2/Service1.svc/InsertVoucher";

function safeStr(v) {
  return String(v ?? "");
}

function clampPieces(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(5, Math.floor(n)));
}

function withCorsHeaders(headers = {}) {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function cors(resp) {
  const h = new Headers(resp.headers || {});
  const extra = withCorsHeaders(Object.fromEntries(h.entries()));
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: extra,
  });
}

function jsonOK(payload) {
  return new Response(JSON.stringify({ success: true, ...payload }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function jsonFAIL(message, status = 200, extra = {}) {
  return new Response(JSON.stringify({ success: false, message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

async function adminGraphql(admin, query, variables) {
  const r = await admin.graphql(query, { variables });
  const j = await r.json();
  if (j?.errors?.length) {
    const msg = j.errors.map((e) => e.message).join(" | ");
    throw new Error(`Shopify GraphQL error: ${msg}`);
  }
  return j;
}

async function getOrder(admin, orderGid) {
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
          city
          province
          zip
          phone
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
trackingInfoInput: {
  company: "EasyMail",
  numbers: trackingNumbers,
  urls: trackingNumbers.map(makeTrackingUrl),
},

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
trackingInfo: {
  company: "EasyMail",
  numbers: trackingNumbers,
  urls: trackingNumbers.map(makeTrackingUrl),
},

    },
  };
  const j = await adminGraphql(admin, mutation, variables);
  return {
    errs: j?.data?.fulfillmentCreateV2?.userErrors || [],
    newId: j?.data?.fulfillmentCreateV2?.fulfillment?.id || null,
  };
}

function extractAllShipmentNumbers(esmJson) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.ShipmentNumber) out.push(String(node.ShipmentNumber));
    if (Array.isArray(node.Vouchers)) {
      for (const v of node.Vouchers) walk(v);
    }
  };
  walk(esmJson);
  return uniq(out);
}

function makeLabelUrl(number) {
  return `/api/easymail-label-pdf?number=${encodeURIComponent(String(number))}`;
}

function makeTrackingUrl(number) {
  const n = encodeURIComponent(String(number));
  return `https://www.easymail.gr/index.php/web-tracking?${n}`;
}


// Helpers
function to2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

// ✅ Parse COD override from UI (?cod=1|0)
function parseCodOverride(param) {
  if (param === null || param === undefined || param === "") return null; // no override
  const v = String(param).trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return null; // unknown => treat as no override
}

export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const orderGid = url.searchParams.get("orderId");
    if (!orderGid) return cors(jsonFAIL("Missing orderId", 400));

    const forceNew = url.searchParams.get("forceNew") === "1";
    const pieces = clampPieces(url.searchParams.get("pieces") || "1");

    // ✅ new: optional override from UI
    const codOverride = parseCodOverride(url.searchParams.get("cod"));

    const order = await getOrder(admin, orderGid);
    if (!order) return cors(jsonFAIL("Order not found or access denied.", 200));

    const { get } = extractMetafields(order);

    const existingVoucher = safeStr(get(KEY_VOUCHER));
    const existingLabelUrl = safeStr(get(KEY_LABEL_URL));
    const existingCreatedAt = safeStr(get(KEY_CREATED_AT));
    const existingPieces = safeStr(get(KEY_PIECES));
    const existingCurrentNumbersRaw = safeStr(get(KEY_CURRENT_NUMBERS));

    if (existingVoucher && !forceNew) {
      // reconstruct labels from current_numbers if present
      let nums = [];
      if (existingCurrentNumbersRaw) {
        try {
          const parsed = JSON.parse(existingCurrentNumbersRaw);
          if (Array.isArray(parsed)) nums = parsed.map(String);
        } catch {
          // ignore
        }
      }
      if (!nums.length) nums = [String(existingVoucher)];

      const labels = uniq(nums).map((n) => ({ number: n, url: makeLabelUrl(n) }));
      const masterUrl = existingLabelUrl || makeLabelUrl(existingVoucher);

      // Note: we don't generate anything here, so COD override doesn't apply.
      // We still return the order COD autodetect info for UI convenience.
      const autoIsCOD = (order.tags || []).includes("COD");
      const orderTotal = to2(order?.currentTotalPriceSet?.shopMoney?.amount);

      return cors(
        jsonOK({
          exists: true,
          voucherNumber: existingVoucher,
          labelUrl: masterUrl,
          labels,
          shipmentNumbers: labels.map((l) => l.number),
          createdAtIso: existingCreatedAt || "",
          pieces: existingPieces || "1",
          message: "A label has already been generated for this order.",
          cod: { isCOD: autoIsCOD, orderTotal },
        })
      );
    }

    if (!process.env.EASYMAIL_USER || !process.env.EASYMAIL_PASSWORD) {
      return cors(jsonFAIL("Missing EASYMAIL_USER / EASYMAIL_PASSWORD in .env", 200));
    }

    const ship = order.shippingAddress || {};
    const customer = order.customer || {};

    const fullName =
      safeStr(ship.name) ||
      `${safeStr(customer.firstName)} ${safeStr(customer.lastName)}`.trim() ||
      "Customer";

    // ✅ COD logic: autodetect + UI override
    const autoIsCOD = (order.tags || []).includes("COD");
    const isCOD = codOverride === null ? autoIsCOD : codOverride;

    const orderTotal = to2(order?.currentTotalPriceSet?.shopMoney?.amount);
    const codCash = isCOD && orderTotal > 0 ? orderTotal : 0;

    const insertPayload = {
      Voucher: {
        ShipmentNumber: 0,
        MasterShipmentNumber: null,
        CustomerID: 0,

        ConsigneeName: fullName,
        ConsigneeCity: safeStr(ship.city),
        ConsigneeArea: safeStr(ship.province) || safeStr(ship.city),
        ConsigneePostalCode: safeStr(ship.zip),
        ConsigneeAddress: safeStr(ship.address1),

        ConsigneePhone1: safeStr(ship.phone) || safeStr(customer.phone) || "",
        ConsigneePhone2: null,
        ConsigneePhone3: null,

        ConsigneeEMail: safeStr(customer.email) || null,
        ConsigneeVat: null,

        ShipmentNotes: `Order ${order.name}`,
        Piecies: Number(pieces),
        Weight: 2.0,

        Height: null,
        Length: null,
        Width: null,

        Collected: false,

        // ✅ this is what we control with UI
        COD_Cash: codCash > 0 ? codCash : 0,
        COD_Cheques: null,

        Insurance: null,

        DeliveryEarly: null,
        DeliveryFromTime: null,
        DeliveryToTime: null,
        DeliverySunday: null,
        DeliverySaturday: null,

        CollectMoney: null,
        PickUpProtocol: null,
        PickUpDeclaration: null,
        SubmitDocumentary: null,
        ReturnDocumentary: null,
        SameDay: null,
        PreferredPicUpDate: null,
        PickUpTimeFrom: null,
        PickUpTimeTo: null,
        CreateReturnNumber: null,
        ReturnShipmentNumber: 0.0,
        ReturnItemID: null,
        DeliveryPoint: null,
        IsReturnVoucher: null,
        SenderName: null,
        SenderCity: null,
        SenderArea: null,
        SenderPostalCode: null,
        SenderAddress: null,
        SenderPhone: null,
      },
      Credential: {
        UserName: process.env.EASYMAIL_USER,
        Password: process.env.EASYMAIL_PASSWORD,
      },
    };

    const esmResp = await fetch(ESM_INSERT_VOUCHER, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(insertPayload),
    });

    const esmText = await esmResp.text();
    let esmJson;

    try {
      esmJson = JSON.parse(esmText);
    } catch {
      const preview = esmText.replace(/\s+/g, " ").slice(0, 300);
      return cors(jsonFAIL(`EasyMail InsertVoucher did not return JSON. Preview: ${preview}`, 200));
    }

    if (!esmJson?.Result) {
      const msg =
        esmJson?.Message ||
        (esmJson?.Messages?.join?.(" | ") ?? "") ||
        "EasyMail InsertVoucher error";
      return cors(jsonFAIL(`EasyMail error: ${msg}`, 200));
    }

    const masterShipmentNumber = esmJson?.ShipmentNumber;
    if (!masterShipmentNumber) return cors(jsonFAIL("EasyMail error: Missing ShipmentNumber.", 200));

    const allNumbers = extractAllShipmentNumbers(esmJson);
    const numbersOrdered = uniq([String(masterShipmentNumber), ...allNumbers]);

    const labels = numbersOrdered.map((n) => ({ number: n, url: makeLabelUrl(n) }));
    const masterLabelUrl = makeLabelUrl(masterShipmentNumber);

    // History (keep old)
    let history = [];
    const historyRaw = safeStr(get(KEY_HISTORY));
    if (historyRaw) {
      try {
        const parsed = JSON.parse(historyRaw);
        if (Array.isArray(parsed)) history = parsed;
      } catch {
        // ignore
      }
    }

    if (existingVoucher && existingVoucher !== String(masterShipmentNumber)) {
      history.unshift({
        voucherNumber: existingVoucher,
        labelUrl: existingLabelUrl || makeLabelUrl(existingVoucher),
        createdAtIso: existingCreatedAt || null,
        pieces: existingPieces || null,
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

    // Save the current set in history too (useful for auditing)
    history.unshift({
      voucherNumber: String(masterShipmentNumber),
      labelUrl: masterLabelUrl,
      createdAtIso: new Date().toISOString(),
      pieces: String(pieces),
      shipmentNumbers: numbersOrdered,
    });
    history = history.slice(0, 20);

    const mfErrors = await setMetafields(admin, order.id, [
      { key: KEY_VOUCHER, type: "single_line_text_field", value: String(masterShipmentNumber) },
      { key: KEY_LABEL_URL, type: "single_line_text_field", value: String(masterLabelUrl) },
      { key: KEY_CREATED_AT, type: "single_line_text_field", value: new Date().toISOString() },
      { key: KEY_PIECES, type: "single_line_text_field", value: String(pieces) },
      { key: KEY_CURRENT_NUMBERS, type: "json", value: JSON.stringify(numbersOrdered) },
      { key: KEY_HISTORY, type: "json", value: JSON.stringify(history) },
    ]);

    // Tracking: include ALL numbers (master + children)
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

    return cors(
      jsonOK({
        exists: false,
        voucherNumber: String(masterShipmentNumber),
        labelUrl: masterLabelUrl,
        labels,
        shipmentNumbers: numbersOrdered,
        message: `Label generated. Master: ${masterShipmentNumber} • Pieces: ${pieces} • Labels: ${numbersOrdered.length} • ${fulfMsg}${mfWarn ? " " + mfWarn : ""}`,
        cod: {
          autoIsCOD,
          isCOD,
          override: codOverride, // null | true | false
          orderTotal,
          codCash,
        },
      })
    );
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("CREATE LABEL ERROR:", e);
    return cors(jsonFAIL(e?.message || "Error while processing request.", 200));
  }
}

