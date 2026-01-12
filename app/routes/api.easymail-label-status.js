import { authenticate } from "../shopify.server";

const NS = "easymail";
const KEY_VOUCHER = "voucher_number";
const KEY_LABEL_URL = "label_url";
const KEY_CREATED_AT = "created_at";
const KEY_PIECES = "pieces";
const KEY_CURRENT_NUMBERS = "current_numbers";

function safeStr(v) {
  return String(v ?? "");
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

function makeLabelUrl(number) {
  return `/api/easymail-label-pdf?number=${encodeURIComponent(String(number))}`;
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

// Helpers
function to2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

async function getOrderMetaAndCodInfo(admin, orderGid) {
  const q = `#graphql
    query GetOrderMetaAndCod($id: ID!) {
      order(id: $id) {
        id
        tags
        currentTotalPriceSet { shopMoney { amount currencyCode } }
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

export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const orderGid = url.searchParams.get("orderId");
    if (!orderGid) return cors(jsonFAIL("Missing orderId", 400));

    const order = await getOrderMetaAndCodInfo(admin, orderGid);
    if (!order) return cors(jsonFAIL("Order not found or access denied.", 200));

    const { get } = extractMetafields(order);

    const voucherNumber = safeStr(get(KEY_VOUCHER));
    const labelUrl =
      safeStr(get(KEY_LABEL_URL)) || (voucherNumber ? makeLabelUrl(voucherNumber) : "");
    const createdAtIso = safeStr(get(KEY_CREATED_AT));
    const pieces = safeStr(get(KEY_PIECES)) || "1";
    const currentNumbersRaw = safeStr(get(KEY_CURRENT_NUMBERS));

    let numbers = [];
    if (currentNumbersRaw) {
      try {
        const parsed = JSON.parse(currentNumbersRaw);
        if (Array.isArray(parsed)) numbers = parsed.map(String);
      } catch {
        // ignore
      }
    }
    if (!numbers.length && voucherNumber) numbers = [voucherNumber];

    const labels = uniq(numbers).map((n) => ({ number: n, url: makeLabelUrl(n) }));

    // ✅ COD info for UI auto-check
    const tags = Array.isArray(order?.tags) ? order.tags : [];
    const isCOD = tags.includes("COD");
    const orderTotal = to2(order?.currentTotalPriceSet?.shopMoney?.amount);
    const currencyCode = safeStr(order?.currentTotalPriceSet?.shopMoney?.currencyCode);

    return cors(
      jsonOK({
        exists: Boolean(voucherNumber),
        voucherNumber,
        labelUrl,
        labels,
        createdAtIso,
        pieces,

        // New fields for UI
        tags,
        isCOD,
        orderTotal,
        currencyCode,
      })
    );
  } catch (e) {
    if (e instanceof Response) return e;
    return cors(jsonFAIL(e?.message || "Error while reading label status.", 200));
  }
}

