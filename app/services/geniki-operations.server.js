import { randomUUID } from "node:crypto";
import db from "../db.server";
import { adminGraphql } from "./acs-create-label.server";
import { genikiLive, genikiSandbox, genikiParcelNumbers,genikiJobFromLookup } from "./geniki.server";
import {confirmedCompletionDate} from "./tracking-retention";


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
    const job = genikiJobFromLookup(found,row.reference);
    if (!job)
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
      Comments: ("Order " + fields.reference).slice(0,40),
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

export async function syncGenikiFulfillment(admin, row, result) {
  const status = String(result.Status || "").trim().toUpperCase();
  const target = String(result.DeliveredAt || "").trim().toUpperCase();
  const returned = status === "DELIVERED" && target === "RETURN TO SENDER";
  const delivered = status === "DELIVERED" && target === "RECIPIENT";
  const mapped = delivered ? "DELIVERED" : returned || status === "IN RETURN" ? "FAILURE" : status === "IN TRANSIT" ? "IN_TRANSIT" : null;
  await applyGenikiTag(admin, row, returned ? "RETURN TO SENDER" : status);
  const completedAt=delivered || returned ? confirmedCompletionDate(/(?:Z|[+-]\d\d:\d\d)$/.test(result.DeliveryDate || "")?result.DeliveryDate:null) : null;
  if (!mapped) return;
  if (!row.fulfillmentId) {
    if(delivered || returned)await db.courierShipment.updateMany({where:{id:row.id,shop:row.shop,status:{notIn:["Cancelled","Superseded"]},genikiTerminalSynced:false},
      data:{genikiTerminalSynced:true,completedAt,status:returned?"RETURN TO SENDER":status}});
    return;
  }
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
    if(delivered || returned) await tx.courierShipment.update({where:{id:row.id},data:{genikiTerminalSynced:true,completedAt,status:returned?"RETURN TO SENDER":status}});
  },{timeout:30000});
}
