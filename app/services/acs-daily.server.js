import {adminGraphql} from "./acs-create-label.server";
import {makeAcsLabelUrl} from "./acs.server";
const NS="acs";
const safeStr=v=>String(v??"");
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
                address1 address2
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

export async function dailyAcsLabels(admin, selectedDate){
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
          addressPreview:[order.shippingAddress?.address1,order.shippingAddress?.address2,order.shippingAddress?.zip,order.shippingAddress?.city].filter(Boolean).join(', '),
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

return labels;
}
