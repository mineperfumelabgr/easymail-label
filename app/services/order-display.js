export const fulfillmentScopes = {
  all: "",
  unfulfilled: "(fulfillment_status:unfulfilled OR fulfillment_status:partial OR fulfillment_status:unshipped)",
  fulfilled: "fulfillment_status:fulfilled",
  on_hold: "fulfillment_status:on_hold",
};

export const isPosOrder = order => String(order?.sourceName || order?.orderSourceName || "").trim().toLowerCase() === "pos";

export function matchesFulfillmentScope(order, scope) {
  if (isPosOrder(order)) return false;
  if (scope === "all") return true;
  if (order.cancelledAt) return false;
  const status = order.displayFulfillmentStatus;
  if (scope === "fulfilled") return status === "FULFILLED";
  if (scope === "on_hold") return status === "ON_HOLD";
  return ["UNFULFILLED", "OPEN", "PARTIALLY_FULFILLED", "IN_PROGRESS", "PENDING_FULFILLMENT", "REQUEST_DECLINED"].includes(status);
}

export function fulfillmentLabel(order) {
  if (order.cancelledAt) return "Cancelled";
  return ({FULFILLMENT_NOT_REQUIRED:"Fulfillment not required", PARTIALLY_FULFILLED:"Partially fulfilled"})[order.displayFulfillmentStatus] ||
    String(order.displayFulfillmentStatus || "Unknown").toLowerCase().replaceAll("_", " ");
}

export function shopifyAdminLink(shop, resource, gid) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop || "")) return null;
  const type = resource === "orders" ? "Order" : resource === "customers" ? "Customer" : null;
  const id = type && String(gid || "").match(new RegExp(`^gid://shopify/${type}/(\\d+)$`))?.[1];
  return id ? `https://admin.shopify.com/store/${shop.replace(/\.myshopify\.com$/, "")}/${resource}/${id}` : null;
}

export function orderIdentity(order) {
  return {
    ...(Object.hasOwn(order, "customer") ? {customerId: order.customer?.id || null} : {}),
    ...(Object.hasOwn(order.customer || {}, "displayName") ? {customerName: order.customer.displayName || null} : {}),
    ...(Object.hasOwn(order, "email") ? {customerEmail: order.email || null} : {}),
    orderSourceName: order.sourceName || null,
    recipientName: order.shippingAddress?.name || null,
    ...(Object.hasOwn(order.shippingAddress || {}, "phone") ? {recipientPhone: order.shippingAddress.phone || null} : {}),
    addressPreview: [order.shippingAddress?.address1, order.shippingAddress?.address2, order.shippingAddress?.zip, order.shippingAddress?.city].filter(Boolean).join(", ") || null,
    country: order.shippingAddress?.countryCodeV2 || null,
  };
}

export function matchesOrderSearch(order, query) {
  const q = String(query || "").trim().toLocaleLowerCase();
  return !q || [order.name, order.orderName, order.shippingAddress?.name, order.recipientName, order.customerName, order.customerEmail, order.email, order.voucher]
    .some(value => String(value || "").toLocaleLowerCase().includes(q));
}
