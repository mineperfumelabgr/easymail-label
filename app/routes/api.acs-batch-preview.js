import { authenticate } from "../shopify.server";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function safeStr(value) {
  return String(value ?? "").trim();
}

export async function loader({ request }) {
  let cors = (response) => response;
  try {
    const auth = await authenticate.admin(request);
    const { admin } = auth;
    cors = auth.cors || cors;
    const url = new URL(request.url);
    let requestedOrders = [];
    try {
      requestedOrders = JSON.parse(url.searchParams.get("orders") || "[]");
    } catch {
      requestedOrders = [];
    }

    if (!Array.isArray(requestedOrders) || !requestedOrders.length || requestedOrders.length > 100) {
      return new Response("Invalid order selection.", { status: 400 });
    }

    const ids = [...new Set(requestedOrders.map((order) => safeStr(order?.orderId)).filter(Boolean))];
    const response = await admin.graphql(
      `#graphql
        query AcsBatchPrintPreview($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Order {
              id
              name
              currentTotalPriceSet { shopMoney { amount currencyCode } }
              customer { firstName lastName }
              shippingAddress { name }
              lineItems(first: 50) { nodes { title variantTitle quantity } }
            }
          }
        }
      `,
      { variables: { ids } },
    );
    const payload = await response.json();
    if (payload?.errors?.length) {
      throw new Error(payload.errors.map((item) => item.message).join(" | "));
    }

    const byId = new Map((payload?.data?.nodes || []).filter(Boolean).map((order) => [order.id, order]));
    const rows = requestedOrders.map((requested) => {
      const order = byId.get(safeStr(requested.orderId));
      if (!order) return "";
      const customer = safeStr(order.shippingAddress?.name) ||
        [order.customer?.firstName, order.customer?.lastName].map(safeStr).filter(Boolean).join(" ");
      const products = (order.lineItems?.nodes || []).map((item) => {
        const variant = item.variantTitle && item.variantTitle !== "Default Title" ? ` — ${item.variantTitle}` : "";
        return `${safeStr(item.title)}${variant} × ${Number(item.quantity) || 0}`;
      }).join(", ");
      const total = safeStr(order.currentTotalPriceSet?.shopMoney?.amount);
      const currency = safeStr(order.currentTotalPriceSet?.shopMoney?.currencyCode);
      return `<tr><td>${escapeHtml(order.name)}</td><td>${escapeHtml(customer || "—")}</td><td>${escapeHtml(products || "Order details unavailable")}</td><td>${escapeHtml(requested.pieces || "1")}</td><td>${escapeHtml(requested.pickupDate || "")}</td><td>${escapeHtml(total ? `${total} ${currency}` : "")}</td></tr>`;
    }).filter(Boolean).join("");

    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ACS batch order summary</title><style>
      @page { size: A4 landscape; margin: 14mm; }
      body { font: 12px Arial, sans-serif; color: #222; padding: 16px; }
      h1 { font-size: 20px; margin: 0 0 6px; }
      p { color: #666; margin: 0 0 16px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; padding: 8px 6px; }
      th { background: #f3f3f3; font-weight: 600; }
      td:first-child { white-space: nowrap; font-weight: 600; }
    </style></head><body><h1>ACS batch order summary</h1><p>${rows ? requestedOrders.length : 0} selected order(s)</p><table><thead><tr><th>Order</th><th>Customer</th><th>Products</th><th>Pieces</th><th>Pickup date</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;

    return cors(new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }));
  } catch (error) {
    if (error instanceof Response) return error;
    return cors(new Response(`Could not load ACS batch preview: ${escapeHtml(error?.message || "Unknown error")}`, {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    }));
  }
}
