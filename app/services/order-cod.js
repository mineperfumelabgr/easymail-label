export function orderCod(order) {
  const money = order.totalOutstandingSet?.shopMoney;
  const amount = Number(money?.amount);
  const tagged = order.tags?.some(tag => tag.trim().toUpperCase() === "COD");
  const gateway = order.paymentGatewayNames?.some(name => /cash on delivery|αντικαταβολ|\bCOD\b/i.test(name));
  const domestic = order.shippingAddress?.countryCodeV2 === "GR";
  return {
    domestic,
    identified: Boolean(tagged || gateway),
    enabled: Boolean(domestic && (tagged || gateway) && amount > 0),
    amount,
    currency: money?.currencyCode,
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
