import { randomUUID } from "node:crypto";
import db from "../db.server";
import {
  adminGraphql,
  createOrReuseAcsLabel,
  todayYMD,
} from "./acs-create-label.server";
import { genikiLive, genikiSandbox } from "./geniki.server";

export const defaults = { GR: "ACS", CY: "Geniki", BG: "Geniki" };
export async function rulesFor(shop) {
  const rules = await db.courierRule.findMany({ where: { shop } });
  return {
    ...defaults,
    ...Object.fromEntries(rules.map((r) => [r.country, r.carrier])),
  };
}

export async function issue(admin, shop, orderId, carrier, weight) {
  if (!["ACS", "Geniki"].includes(carrier)) throw new Error("Choose a courier");
  const { data } = await adminGraphql(
    admin,
    `query($id:ID!){order(id:$id){
    id name test cancelledAt tags displayFinancialStatus paymentGatewayNames
    totalOutstandingSet{shopMoney{amount currencyCode}}
    shippingAddress{name address1 address2 city zip phone countryCodeV2}
    acs:metafield(namespace:"acs",key:"voucher_number"){value}
    fulfillments(first:100){id trackingInfo{number}}
    fulfillmentOrders(first:50){pageInfo{hasNextPage} nodes{id status assignedLocation{location{id}}
      lineItems(first:250){pageInfo{hasNextPage} nodes{id remainingQuantity}}}}
  }}`,
    { id: orderId },
  );
  const order = data.order;
  if (!order || order.cancelledAt || !order.shippingAddress)
    throw new Error("Order cannot be shipped");
  const address = order.shippingAddress;
  const environment = order.test ? "test" : "live";
  const unique = { shop_orderId_environment: { shop, orderId, environment } };
  let row = await db.courierShipment.findUnique({ where: unique });
  if (row && row.carrier !== carrier)
    throw new Error("Order already assigned to " + row.carrier);
  if (carrier === "Geniki" && order.acs?.value)
    throw new Error("An ACS voucher already exists");
  if (order.test && carrier === "ACS")
    throw new Error("ACS is configured for real shipments");
  if (row?.status === "Cancelled")
    throw new Error("Voucher cancelled. Review this order before reissuing.");
  if (row?.voucher && (carrier === "ACS" || row.fulfillmentId)) return row;
  const api = order.test ? genikiSandbox : genikiLive;
  let key;
  if (carrier === "Geniki") key = await api.authenticate();
  const groups = order.fulfillmentOrders.nodes
    .filter((g) => g.status === "OPEN" || g.status === "IN_PROGRESS")
    .map((g) => ({
      location: g.assignedLocation?.location?.id,
      fulfillmentOrderId: g.id,
      fulfillmentOrderLineItems: g.lineItems.nodes
        .filter((i) => i.remainingQuantity > 0)
        .map((i) => ({ id: i.id, quantity: i.remainingQuantity })),
    }))
    .filter((g) => g.fulfillmentOrderLineItems.length);
  if (
    !row &&
    carrier === "Geniki" &&
    (!groups.length ||
      new Set(groups.map((g) => g.location)).size !== 1 ||
      order.fulfillmentOrders.pageInfo.hasNextPage ||
      order.fulfillmentOrders.nodes.some(
        (g) => g.lineItems.pageInfo.hasNextPage,
      ))
  )
    throw new Error(
      "Review fulfillment quantities and locations before shipping",
    );
  const outstanding = Number(order.totalOutstandingSet?.shopMoney?.amount);
  const cod =
    order.tags.includes("COD") ||
    order.paymentGatewayNames.some((n) =>
      /cash on delivery|αντικαταβολ|\bCOD\b/i.test(n),
    );
  if (
    !row &&
    carrier === "Geniki" &&
    outstanding > 0 &&
    (!cod ||
      address.countryCodeV2 !== "GR" ||
      order.totalOutstandingSet.shopMoney.currencyCode !== "EUR")
  )
    throw new Error("Review outstanding payment before shipping");
  const fresh = !row;
  if (!row)
    row = await db.courierShipment.create({
      data: {
        shop,
        orderId,
        environment,
        orderName: order.name,
        country: address.countryCodeV2,
        carrier,
        reference: randomUUID(),
        fulfillmentPlan: groups.map(({ location, ...plan }) => plan),
      },
    });
  if (carrier === "ACS") {
    if (!fresh && !order.acs?.value)
      throw new Error("Check the earlier ACS request before retrying");
    const r = await createOrReuseAcsLabel({
      admin,
      orderGid: orderId,
      requestedPickupDate: todayYMD(),
    });
    return db.courierShipment.update({
      where: { id: row.id },
      data: {
        voucher: r.voucherNumber,
        labels: r.shipmentNumbers,
        status: r.message,
      },
    });
  }
  if (!row.voucher) {
    let voucher, jobId;
    if (fresh) {
      const r = await api.create(key, {
        OrderId: row.reference,
        Name: address.name,
        Address: [address.address1, address.address2].filter(Boolean).join(" "),
        CountryIso: address.countryCodeV2,
        City: address.city,
        Telephone: address.phone || "",
        Zip: address.zip,
        Pieces: 1,
        Weight: weight,
        Services: cod && outstanding > 0 ? "ΑΜ" : "",
        CodAmount: cod ? outstanding : 0,
        InsAmount: 0,
        ReceivedDate: new Date().toISOString(),
      });
      voucher = r.Voucher;
      jobId = r.JobId;
    } else {
      const r = await api.lookup(key, row.reference);
      const job = r.Jobs?.VoucherJob;
      if (r.Count !== "1" || !job || job.IsCanceled === "true")
        throw new Error(
          "Verify the previous request with Geniki before reissuing",
        );
      voucher = job.Voucher?.VoucherNo;
      jobId = job.Id;
    }
    if (!voucher || !jobId) throw new Error("Missing Geniki voucher details");
    row = await db.courierShipment.update({
      where: { id: row.id },
      data: {
        voucher,
        jobId: String(jobId),
        labels: [voucher],
        status: "Label issued",
      },
    });
  }
  const match = order.fulfillments.find((f) =>
    f.trackingInfo.some((t) => t.number === row.voucher),
  );
  if (match)
    return db.courierShipment.update({
      where: { id: row.id },
      data: { fulfillmentId: match.id },
    });
  const claimed = await db.courierShipment.updateMany({
    where: { id: row.id, status: "Label issued", fulfillmentId: null },
    data: { status: "Submitting fulfillment" },
  });
  if (!claimed.count)
    throw new Error("Check Shopify fulfillment before retrying");
  const result = await adminGraphql(
    admin,
    `mutation($input:FulfillmentInput!){fulfillmentCreate(fulfillment:$input){fulfillment{id} userErrors{message}}}`,
    {
      input: {
        notifyCustomer: !order.test,
        lineItemsByFulfillmentOrder: row.fulfillmentPlan,
        trackingInfo: {
          company: "Geniki Tachydromiki",
          number: row.voucher,
          url:
            "https://www.taxydromiki.com/en/track/" +
            encodeURIComponent(row.voucher),
        },
      },
    },
  );
  const response = result.data.fulfillmentCreate;
  if (!response.fulfillment) {
    await db.courierShipment.update({
      where: { id: row.id },
      data: { status: "Label issued" },
    });
    throw new Error(response.userErrors.map((e) => e.message).join(", "));
  }
  return db.courierShipment.update({
    where: { id: row.id },
    data: {
      fulfillmentId: response.fulfillment.id,
      status: "Ready for pickup",
    },
  });
}
