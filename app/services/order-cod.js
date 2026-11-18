export function orderCod(order) {
  const outstandingMoney = order.totalOutstandingSet?.shopMoney;
  const outstanding = Number(outstandingMoney?.amount);
  const tagged = Boolean(order.tags?.some(tag => tag.trim().toUpperCase() === "COD"));
  const gateway = Boolean(order.paymentGatewayNames?.some(name => /cash on delivery|αντικαταβολ|\bCOD\b/i.test(name)));
  const domestic = order.shippingAddress?.countryCodeV2 === "GR";
  // An explicit COD tag is also used on test orders recorded as paid in Shopify.
  const useOrderTotal = tagged && !(outstanding > 0);
  const money = useOrderTotal ? order.currentTotalPriceSet?.shopMoney : outstandingMoney;
  const amount = Number(money?.amount);
  return {
    domestic,
    identified: tagged || gateway,
    enabled: Boolean(domestic && (tagged || (gateway && outstanding > 0))),
    amount,
    currency: money?.currencyCode || outstandingMoney?.currencyCode,
    source: useOrderTotal ? "order total" : "outstanding balance",
  };
}

export function collectionAmount(order, override, enteredAmount) {
  const cod = orderCod(order);
  if (!cod.domestic) {
    if (override === true) throw new Error("COD is available for Greece only.");
    return 0;
  }
  if (!(override ?? cod.enabled)) return 0;
  const amount = enteredAmount ?? cod.amount;
  if (cod.currency !== "EUR" || !Number.isFinite(amount) || amount <= 0)
    throw new Error("Enter a positive COD amount in EUR.");
  return amount;
}
