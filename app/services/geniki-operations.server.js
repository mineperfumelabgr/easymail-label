import { randomUUID } from "node:crypto";
import db from "../db.server";
import { adminGraphql } from "./acs-create-label.server";
import { genikiLive, genikiSandbox, genikiParcelNumbers } from "./geniki.server";
import {isPosOrder} from "./order-display";


export async function applyGenikiTag(admin, row, status) {
  if (row.country !== "GR") return;
  const orderId = row.sourceOrderId || row.orderId;
  if (!orderId.startsWith("gid://shopify/Order/")) return;
  const rule = await db.genikiTagRule.findUnique({
    where: { shop_status: { shop: row.shop, status: status.toUpperCase() } },
  });
  const returnStatus = {"IN RETURN":"RETURNING","RETURN TO SENDER":"RETURNED"}[status.toUpperCase()];
  const shared = returnStatus ? await db.acsTrackingTagRule.findFirst({where:{shop:row.shop,status:returnStatus,enabled:true}}) : null;
  const tags=[...new Set([shared?.tag,rule?.tag].map(t=>t?.trim()).filter(Boolean))];
  if (!tags.length) return;
  const r = await adminGraphql(
    admin,
    `mutation($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){userErrors{message}}}`,
    { id: orderId, tags },
  );
  if (r.data.tagsAdd.userErrors.length)
    throw new Error(r.data.tagsAdd.userErrors[0].message);
}

export async function createGenikiParcel(
  shop,
  environment,
  orderId,
  fields,
  extra = {},
) {
  const api = environment === "test" ? genikiSandbox : genikiLive,
    key = await api.authenticate();
  const where = { shop_orderId_environment: { shop, orderId, environment } };
  let row = await db.courierShipment.findUnique({ where });
  if (row?.voucher) return row;
  let number, jobId, records;
  if (row) {
    const found = await api.lookup(key, row.reference);
    const job = found.Jobs?.VoucherJob;
    if (found.Count !== "1" || !job || job.IsCanceled === "true")
      throw new Error("Previous request requires verification with Geniki.");
    number = job.Voucher?.VoucherNo;
    jobId = job.Id;
    records = job.SubVouchers?.Record;
  } else {
    row = await db.courierShipment.create({
      data: {
        shop,
        environment,
        orderId,
        orderName: fields.reference,
        country: fields.country,
        recipientName: fields.name,
        recipientPhone: fields.phone || null,
        addressPreview:[fields.address, fields.zip, fields.city].filter(Boolean).join(', '),
        carrier: "Geniki",
        codAmount:fields.cod || 0,
        reference: randomUUID(),
        weight:fields.weight,
        ...extra,
      },
    });
    const result = await api.create(key, {
      OrderId: row.reference,
      Name: fields.name,
      Address: fields.address,
      CountryIso: fields.country,
      City: fields.city,
      Telephone: fields.phone,
      Zip: fields.zip,
      Pieces: row.pieces || 1,
      Weight: fields.weight,
      Services: fields.cod ? "ΑΜ" : "",
      CodAmount: fields.cod || 0,
      InsAmount: 0,
      ReceivedDate: new Date().toISOString(),
    });
    jobId = result.JobId;
    number = result.Voucher;
    records = result.SubVouchers?.Record;
  }
  if (!number || !jobId) throw new Error("Geniki did not confirm the voucher.");
  return db.courierShipment.update({
    where: { id: row.id },
    data: {
      jobId: String(jobId),
      voucher: number,
      labels: genikiParcelNumbers(number, records, row.pieces),
      status: extra.previousId ? "Label issued" : "Ready for pickup",
    },
  });
}

export async function replaceGeniki(admin, shop, previousId, weight) {
  const prior = await db.courierShipment.findFirst({
    where: { id: previousId, shop, carrier: "Geniki" },
  });
  const orderId = prior?.sourceOrderId || prior?.orderId;
  if (
    !prior?.voucher ||
    !prior.fulfillmentId ||
    !orderId?.startsWith("gid://shopify/Order/")
  )
    throw new Error("Choose a Geniki voucher with a Shopify fulfillment.");
  const { data } = await adminGraphql(
    admin,
    `query($id:ID!,$fid:ID!){order(id:$id){name sourceName cancelledAt shippingAddress{name address1 address2 city zip phone countryCodeV2} tags paymentGatewayNames totalOutstandingSet{shopMoney{amount currencyCode}}} fulfillment:node(id:$fid){... on Fulfillment{id status trackingInfo{number url}}}}`,
    { id: orderId, fid: prior.fulfillmentId },
  );
  const o = data.order,
    f = data.fulfillment,
    a = o?.shippingAddress;
  if (!a || isPosOrder(o) || o.cancelledAt || !f || f.status === "CANCELLED")
    throw new Error(
      "Review the order and fulfillment before replacing its label.",
    );
  const amount = prior.codAmount ?? Number(o.totalOutstandingSet.shopMoney.amount);
  if (
    prior.codAmount == null && amount &&
    (!(
      o.tags.includes("COD") ||
      o.paymentGatewayNames.some((n) =>
        /cash on delivery|αντικαταβολ|\bCOD\b/i.test(n),
      )
    ) ||
      a.countryCodeV2 !== "GR" ||
      o.totalOutstandingSet.shopMoney.currencyCode !== "EUR")
  )
    throw new Error("Review outstanding payment.");
  const row = await createGenikiParcel(
    shop,
    prior.environment,
    "replacement:" + prior.id,
    {
      reference: o.name,
      name: a.name,
      address: [a.address1, a.address2].filter(Boolean).join(" "),
      city: a.city,
      zip: a.zip,
      country: a.countryCodeV2,
      phone: a.phone || "",
      weight,
      cod: amount,
    },
    { previousId: prior.id, sourceOrderId: orderId, preparedBy:prior.preparedBy, pieces:prior.pieces || 1 },
  );
  if (row.fulfillmentId) return row;
  const newNumbers=row.labels || [row.voucher];
  const replaced=new Set([...(prior.labels || [prior.voucher]), ...newNumbers]);
  const info = f.trackingInfo.filter(
    (t) => !replaced.has(t.number),
  );
  const numbers = [...info.map((t) => t.number), ...newNumbers];
  const urls = [
    ...info.map((t) => t.url),
    ...newNumbers.map(n=>"https://www.taxydromiki.com/en/track/" + n),
  ];
  const result = await adminGraphql(
    admin,
    `mutation($id:ID!,$tracking:FulfillmentTrackingInput!){fulfillmentTrackingInfoUpdate(fulfillmentId:$id,trackingInfoInput:$tracking,notifyCustomer:false){fulfillment{id} userErrors{message}}}`,
    {
      id: f.id,
      tracking: {
        company: "Geniki Tachydromiki",
        numbers,
        ...(urls.every(Boolean) ? { urls } : {}),
      },
    },
  );
  const updated = result.data.fulfillmentTrackingInfoUpdate;
  if (!updated.fulfillment)
    throw new Error(updated.userErrors.map((e) => e.message).join(", "));
  await db.$transaction([
    db.courierShipment.update({
      where: { id: prior.id },
      data: { status: "Superseded" },
    }),
    db.courierShipment.update({
      where: { id: row.id },
      data: { fulfillmentId: f.id, status: "Ready for pickup" },
    }),
  ]);
  return row;
}

export async function syncGenikiFulfillment(admin, row, result) {
  const status = String(result.Status || "").trim().toUpperCase();
  const target = String(result.DeliveredAt || "").trim().toUpperCase();
  const returned = status === "DELIVERED" && target === "RETURN TO SENDER";
  const delivered = status === "DELIVERED" && target === "RECIPIENT";
  const mapped = delivered ? "DELIVERED" : returned || status === "IN RETURN" ? "FAILURE" : status === "IN TRANSIT" ? "IN_TRANSIT" : null;
  await applyGenikiTag(admin, row, returned ? "RETURN TO SENDER" : status);
  if (!mapped || !row.fulfillmentId) return;
  await db.$transaction(async tx => {
    // Serialize refreshes of this shipment and re-read Shopify after acquiring the lock.
    const current = await tx.courierShipment.update({where:{id:row.id},data:{checkedAt:new Date()}});
    if (current.genikiTerminalSynced || ["Cancelled","Superseded"].includes(current.status) || current.fulfillmentId !== row.fulfillmentId) return;
    const {data} = await adminGraphql(admin,`query($id:ID!){node(id:$id){... on Fulfillment {status displayStatus trackingInfo{number} events(first:1,sortKey:HAPPENED_AT,reverse:true){nodes{status}}}}}`,{id:row.fulfillmentId});
    const fulfillment = data.node;
    if (!fulfillment || fulfillment.status === "CANCELLED" || !fulfillment.trackingInfo.some(t=>t.number === row.voucher)) return;
    const last = fulfillment.events.nodes[0]?.status;
    if (last !== "DELIVERED" && fulfillment.displayStatus !== "DELIVERED" && last !== mapped && fulfillment.displayStatus !== mapped) {
      const event={fulfillmentId:row.fulfillmentId,status:mapped,message:"Geniki "+row.voucher+" · "+(returned?"Returned to sender":status)};
      const time = result.DeliveryDate;
      if (delivered && time && /(?:Z|[+-]\d\d:\d\d)$/.test(time) && Number.isFinite(Date.parse(time))) event.happenedAt=new Date(time).toISOString();
      const response=await adminGraphql(admin,`mutation($event:FulfillmentEventInput!){fulfillmentEventCreate(fulfillmentEvent:$event){userErrors{message}}}`,{event});
      const errors=response.data.fulfillmentEventCreate.userErrors;
      if(errors.length) throw new Error(errors.map(e=>e.message).join(", "));
    }
    if(delivered || returned) await tx.courierShipment.update({where:{id:row.id},data:{genikiTerminalSynced:true,status:returned?"RETURN TO SENDER":status}});
  },{timeout:30000});
}
