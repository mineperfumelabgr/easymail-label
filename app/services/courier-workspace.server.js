import {collectionAmount} from "./order-cod";
import { randomUUID } from "node:crypto";
import db from "../db.server";
import {
  adminGraphql,
  createOrReuseAcsLabel,
  todayYMD,
} from "./acs-create-label.server";
import { genikiLive, genikiSandbox, genikiParcelNumbers, isCourierTestShop } from "./geniki.server";

export const defaults = { GR: "ACS", CY: "Geniki", BG: "Geniki" };
export async function rulesFor(shop) {
  const rules = await db.courierRule.findMany({ where: { shop } });
  return {
    ...defaults,
    ...Object.fromEntries(rules.map((r) => [r.country, r.carrier])),
  };
}

export async function issue(admin, shop, orderId, carrier, weight, options = {}) {
  if (!["ACS", "Geniki"].includes(carrier)) throw new Error("Choose a courier");
  const { data } = await adminGraphql(
    admin,
    `query($id:ID!){order(id:$id){
    id name test cancelledAt displayFulfillmentStatus tags displayFinancialStatus paymentGatewayNames
    totalOutstandingSet{shopMoney{amount currencyCode}} currentTotalPriceSet{shopMoney{amount currencyCode}}
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
  if (order.displayFulfillmentStatus === "FULFILLED") throw new Error("This order is fulfilled. Use the dedicated replacement voucher action.");
  const address = order.shippingAddress;
  const testShipment = order.test || isCourierTestShop(shop);
  const environment = testShipment ? "test" : "live";
  const unique = { shop_orderId_environment: { shop, orderId, environment } };
  let row = await db.courierShipment.findUnique({ where: unique });
  if (row?.status === "Superseded") {
    const current = await db.courierShipment.findFirst({where:{shop,sourceOrderId:orderId,environment,carrier:"Geniki",fulfillmentId:{not:null},status:{not:"Superseded"}},orderBy:{createdAt:"desc"}});
    if (!current) throw new Error("Review voucher history in Daily Labels.");
    row=current;
  }
  if (row && row.carrier !== carrier)
    throw new Error("Order already assigned to " + row.carrier);
  if (carrier === "Geniki" && order.acs?.value)
    throw new Error("An ACS voucher already exists");
  if (testShipment && carrier === "ACS")
    throw new Error("ACS is configured for real shipments");
  if (row?.status === "Cancelled")
    throw new Error("Voucher cancelled. Review this order before reissuing.");
  if (row?.voucher && (carrier === "ACS" || row.fulfillmentId)) return row;
  const api = testShipment ? genikiSandbox : genikiLive;
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
  const codAmount = collectionAmount(order, options.codOverride, options.codAmount);
  if (!row && carrier==="Geniki" && outstanding>0 && codAmount===0 && options.codOverride!==false)
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
        recipientName:address.name,
        addressPreview:[address.address1,address.address2,address.zip,address.city].filter(Boolean).join(", "),
        carrier,
        codAmount,
        weight:carrier==="Geniki"?weight:null,
        preparedBy: order.acs?.value ? null : options.employeeName,
        pieces: order.acs?.value ? null : options.pieces || 1,
        reference: randomUUID(),
        fulfillmentPlan: groups.map(({ location, ...plan }) => plan),
      },
    });
  if (carrier === "ACS") {
    if (!fresh && !order.acs?.value)
      throw new Error("Check the earlier ACS request before retrying");
    let submitted=false;
    const r = await createOrReuseAcsLabel({
      beforeSubmit:()=>{submitted=true},
      admin,
      orderGid: orderId,
      requestedPickupDate: options.pickupDate || todayYMD(),
      pieces: options.pieces || 1,
      codOverride: codAmount > 0,
      codAmountOverride: codAmount || null,
    }).catch(async error=>{if(fresh && (!submitted || error.voucherRejected))await db.courierShipment.deleteMany({where:{id:row.id,voucher:null}});throw error});
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
    let voucher, jobId, subVouchers;
    if (fresh) {
      const r = await api.create(key, {
        OrderId: row.reference,
        Name: address.name,
        Address: [address.address1, address.address2].filter(Boolean).join(" "),
        CountryIso: address.countryCodeV2,
        City: address.city,
        Telephone: address.phone || "",
        Zip: address.zip,
        Pieces: row.pieces || 1,
        Weight: weight,
        Services: codAmount > 0 ? "ΑΜ" : "",
        CodAmount: codAmount,
        InsAmount: 0,
        ReceivedDate: new Date().toISOString(),
      }).catch(async error=>{if(/^70[0-6]$/.test(error.genikiCode))await db.courierShipment.deleteMany({where:{id:row.id,voucher:null}});throw error});
      voucher = r.Voucher;
      jobId = r.JobId;
      subVouchers = r.SubVouchers?.Record;
    } else {
      const r = await api.lookup(key, row.reference);
      const job = r.Jobs?.VoucherJob;
      if (r.Count !== "1" || !job || job.IsCanceled === "true")
        throw new Error(
          "Verify the previous request with Geniki before reissuing",
        );
      voucher = job.Voucher?.VoucherNo;
      jobId = job.Id;
      subVouchers = job.SubVouchers?.Record;
    }
    if (!voucher || !jobId) throw new Error("Missing Geniki voucher details");
    const labels = genikiParcelNumbers(voucher, subVouchers, row.pieces);
    row = await db.courierShipment.update({
      where: { id: row.id },
      data: {
        voucher,
        jobId: String(jobId),
        labels,
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
        notifyCustomer: !testShipment,
        lineItemsByFulfillmentOrder: row.fulfillmentPlan,
        trackingInfo: {
          company: "Geniki Tachydromiki",
          numbers: row.labels || [row.voucher],
          urls: (row.labels || [row.voucher]).map(n=>"https://www.taxydromiki.com/en/track/"+encodeURIComponent(n)),
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
