import { authenticate } from "../shopify.server";
import {
  extractPickupLists,
  getAcsPickupLists,
  makeAcsLabelUrl,
  makeAcsPickupListPdfUrl,
} from "../services/acs.server";

const NS = "acs";

function safeStr(v) {
  return String(v ?? "");
}

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function parseDate(v) {
  const s = safeStr(v).trim();
  if (!s) return todayYMD();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error("Date must be in YYYY-MM-DD format.");
  }
  return s;
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

async function adminGraphql(admin, query, variables) {
  const r = await admin.graphql(query, { variables });
  const j = await r.json();
  if (j?.errors?.length) {
    const msg = j.errors.map((e) => e.message).join(" | ");
    throw new Error(`Shopify GraphQL error: ${msg}`);
  }
  return j;
}

async function fetchRecentOrders(admin, maxPages = 5) {
  const out = [];
  let after = null;
  let page = 0;
  let hasNextPage = true;

  while (hasNextPage && page < maxPages) {
    const q = `#graphql
      query RecentOrders($after: String) {
        orders(first: 50, after: $after, sortKey: UPDATED_AT, reverse: true) {
          pageInfo { hasNextPage }
          edges {
            cursor
            node {
              id
              name
              tags
              currentTotalPriceSet { shopMoney { amount currencyCode } }
              shippingAddress {
                name
                city
                zip
                countryCodeV2
              }
              customer {
                firstName
                lastName
                email
              }
              metafields(first: 30, namespace: "${NS}") {
                edges {
                  node {
                    key
                    value
                  }
                }
              }
            }
          }
        }
      }
    `;
    const j = await adminGraphql(admin, q, { after });
    const conn = j?.data?.orders;
    const edges = conn?.edges || [];
    for (const e of edges) out.push(e.node);
    hasNextPage = Boolean(conn?.pageInfo?.hasNextPage);
    after = edges.length ? edges[edges.length - 1].cursor : null;
    page += 1;
  }

  return out;
}

function metafieldMap(order) {
  const map = {};
  for (const edge of order?.metafields?.edges || []) {
    map[edge?.node?.key] = edge?.node?.value ?? "";
  }
  return map;
}

export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const selectedDate = parseDate(url.searchParams.get("date"));

    const orders = await fetchRecentOrders(admin);

    const labels = orders
      .map((order) => {
        const mf = metafieldMap(order);
        const pickupDate = safeStr(mf.pickup_date);
        const voucherNumber = safeStr(mf.voucher_number);
        if (!pickupDate || !voucherNumber) return null;
        if (pickupDate !== selectedDate) return null;

        let numbers = [];
        try {
          const parsed = JSON.parse(mf.current_numbers || "[]");
          if (Array.isArray(parsed)) numbers = parsed.map(String).filter(Boolean);
        } catch {
          numbers = [];
        }
        if (!numbers.length && voucherNumber) numbers = [voucherNumber];

        const customerName =
          safeStr(order?.shippingAddress?.name) ||
          `${safeStr(order?.customer?.firstName)} ${safeStr(order?.customer?.lastName)}`.trim();

        return {
          orderId: order.id,
          orderName: order.name,
          voucherNumber,
          pieces: safeStr(mf.pieces) || "1",
          createdAt: safeStr(mf.created_at),
          pickupDate,
          contentTypeId: safeStr(mf.content_type_id),
          isCOD: (order.tags || []).includes("COD"),
          totalAmount: safeStr(order?.currentTotalPriceSet?.shopMoney?.amount),
          customerName,
          email: safeStr(order?.customer?.email),
          city: safeStr(order?.shippingAddress?.city),
          zip: safeStr(order?.shippingAddress?.zip),
          country: safeStr(order?.shippingAddress?.countryCodeV2),
          shipmentNumbers: numbers,
          labels: numbers.map((n) => ({
            number: n,
            url: makeAcsLabelUrl(n),
          })),
        };
      })
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    let pickupLists = [];
    try {
      const pickupResp = await getAcsPickupLists(selectedDate);
      pickupLists = extractPickupLists(pickupResp).map((x) => ({
        ...x,
        pdfUrl: makeAcsPickupListPdfUrl(x.pickupListNo, selectedDate),
      }));
    } catch (e) {
      console.warn("ACS GET PICKUP LISTS warning:", e?.message || e);
    }

    return cors(
      jsonOK({
        date: selectedDate,
        labels,
        pickupLists,
      }),
    );
  } catch (e) {
    console.error("ACS DAILY LABELS ERROR:", e);
    return cors(jsonFAIL(e?.message || "Error while loading ACS daily labels.", 200));
  }
}
