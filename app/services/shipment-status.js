const states = {
  DELIVERED: ["Delivered", "delivered"],
  RETURNED: ["Returned to sender", "returned"],
  RETURNING: ["Returning to sender", "returned"],
  IN_TRANSIT: ["In transit", "transit"],
  OUT_FOR_DELIVERY: ["Out for delivery", "transit"],
  CARRIER_PICKED_UP: ["Picked up by courier", "picked-up"],
  LABEL_CREATED: ["Awaiting courier pickup", "waiting"],
  READY_FOR_PICKUP: ["Ready for customer pickup", "waiting"],
  DELIVERY_DELAYED: ["Delivery delayed", "problem"],
  DELIVERY_ATTEMPTED: ["Delivery attempted", "problem"],
  DELIVERY_PROBLEM: ["Delivery problem", "problem"],
  SYNC_ERROR: ["Tracking update failed", "problem"],
  ACS_REVIEW_REQUIRED: ["Manual ACS review required", "problem"],
  UNKNOWN: ["Tracking status to verify", "problem"],
  CANCELLED: ["Cancelled", "returned"],
  SUPERSEDED: ["Replaced voucher", "waiting"],
  CREATING: ["Creating label", "waiting"],
  SUBMITTING_FULFILLMENT: ["Updating Shopify fulfillment", "waiting"],
};
const aliases = {
  "RETURN TO SENDER":"RETURNED", "IN RETURN":"RETURNING", "IN TRANSIT":"IN_TRANSIT",
  "OUT FOR DELIVERY":"OUT_FOR_DELIVERY", "PICKED UP":"CARRIER_PICKED_UP", "PICKED_UP":"CARRIER_PICKED_UP",
  "COLLECTED":"CARRIER_PICKED_UP", "CARRIER PICKED UP":"CARRIER_PICKED_UP", "RECEIVED":"CARRIER_PICKED_UP",
  "READY FOR PICKUP":"LABEL_CREATED", "LABEL ISSUED":"LABEL_CREATED", "ISSUED":"LABEL_CREATED",
  "CLOSED":"LABEL_CREATED", "FINALIZED":"LABEL_CREATED", "LABEL PRINTED":"LABEL_CREATED",
  "SUBMITTING FULFILLMENT":"SUBMITTING_FULFILLMENT", "ATTEMPTED_DELIVERY":"DELIVERY_ATTEMPTED",
  "DELAYED":"DELIVERY_DELAYED", "FAILURE":"DELIVERY_PROBLEM",
  "CONSEGNATO AL DESTINATARIO":"DELIVERED", "RESTITUITO AL MITTENTE":"RETURNED",
  "IN RESTITUZIONE AL MITTENTE":"RETURNING", "SPEDITO / IN TRANSITO":"IN_TRANSIT", "IN CONSEGNA":"OUT_FOR_DELIVERY",
  "DA RITIRARE PRESSO ACS":"READY_FOR_PICKUP", "VERIFICARE INDIRIZZO O DESTINATARIO":"DELIVERY_PROBLEM",
  "CONSEGNA IN RITARDO O RIPROGRAMMATA":"DELIVERY_DELAYED", "CONSEGNA NON COMPLETATA":"DELIVERY_PROBLEM",
  "TENTATIVO DI CONSEGNA NON RIUSCITO":"DELIVERY_ATTEMPTED", "PROBLEMA RILEVATO DURANTE LA CONSEGNA":"DELIVERY_PROBLEM",
};
const labels = Object.fromEntries(Object.entries(states).map(([code,[label]])=>[label.toUpperCase(),code]));

export const trackingStatusFilters = {
  "": "All statuses",
  attention: "Needs attention · problems and returns",
  problem: "Delivery problems",
  waiting: "Awaiting pickup",
  "picked-up": "Picked up by courier",
  transit: "In transit / out for delivery",
  delivered: "Delivered",
  returned: "Returning / returned to sender",
  cancelled: "Cancelled / replaced vouchers",
};

export const trackingStatusChips = [
  ["", "All statuses", "all"],
  ["waiting", "Awaiting pickup", "waiting"],
  ["picked-up", "Picked up", "picked-up"],
  ["transit", "In transit", "transit"],
  ["delivered", "Delivered", "delivered"],
  ["problem", "Problem", "problem"],
  ["returned", "Returned", "returned"],
];

function matchesCode(code, filter) {
  if (!filter) return true;
  if (filter === "cancelled") return ["CANCELLED","SUPERSEDED"].includes(code);
  if (["CANCELLED","SUPERSEDED"].includes(code)) return false;
  if (filter === "attention") return ["problem","returned"].includes(states[code]?.[1]);
  return states[code]?.[1] === filter;
}

export function matchesTrackingStatus(row, filter) {
  return !filter || matchesCode(shipmentStatus(row).code,filter);
}

// Applied before each database result limit. Native ACS rows are reconciled
// with their canonical snapshots by the loader before the final display filter.
export function trackingStatusWhere(filter, source) {
  if (!filter || !Object.hasOwn(trackingStatusFilters,filter)) return {};
  const codes=Object.keys(states).filter(code=>matchesCode(code,filter));
  if (source === "acs") {
    const alternatives=[{status:{in:codes.filter(code=>code!=="IN_TRANSIT")}}];
    if (codes.includes("CARRIER_PICKED_UP")) alternatives.push({status:"IN_TRANSIT",lastShopifyEventStatus:"CARRIER_PICKED_UP"});
    if (codes.includes("IN_TRANSIT")) alternatives.push({status:"IN_TRANSIT",OR:[{lastShopifyEventStatus:null},{lastShopifyEventStatus:{not:"CARRIER_PICKED_UP"}}]});
    return {OR:alternatives};
  }
  const values={...Object.fromEntries(Object.keys(states).map(code=>[code,code])),...aliases,...labels};
  const alternatives=[{status:{in:Object.keys(values).filter(value=>codes.includes(values[value])),mode:"insensitive"}}];
  if (filter === "waiting") alternatives.push({status:{contains:"label",mode:"insensitive"}},{status:{contains:"creat",mode:"insensitive"}});
  if (["problem","attention"].includes(filter)) alternatives.push({NOT:{status:{in:Object.keys(values),mode:"insensitive"}}});
  return {OR:alternatives};
}

export function shipmentStatus(row) {
  const raw = String(row.statusCode || row.status || "").trim().toUpperCase();
  let code = states[raw] ? raw : aliases[raw] || labels[raw];
  if (row.carrier === "ACS" && code === "IN_TRANSIT" && row.checkpointStatus === "CARRIER_PICKED_UP") code = "CARRIER_PICKED_UP";
  if (!code && /AWAITING.*PICKUP|LABEL.*(CREATED|GENERATED)|VOUCHER.*CREAT|SUCCESSFULLY.*CREAT/.test(raw)) code = "LABEL_CREATED";
  const [label, tone] = states[code] || ["Tracking status to verify", "problem"];
  return {code: code || "UNKNOWN", label, tone};
}

