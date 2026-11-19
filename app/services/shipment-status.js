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

export function shipmentStatus(row) {
  const raw = String(row.statusCode || row.status || "").trim().toUpperCase();
  let code = states[raw] ? raw : aliases[raw] || labels[raw];
  if (row.carrier === "ACS" && code === "IN_TRANSIT" && row.checkpointStatus === "CARRIER_PICKED_UP") code = "CARRIER_PICKED_UP";
  if (!code && /AWAITING.*PICKUP|LABEL.*(CREATED|GENERATED)|VOUCHER.*CREAT|SUCCESSFULLY.*CREAT/.test(raw)) code = "LABEL_CREATED";
  const [label, tone] = states[code] || ["Tracking status to verify", "problem"];
  return {code: code || "UNKNOWN", label, tone};
}

