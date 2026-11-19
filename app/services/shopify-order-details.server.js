import {adminGraphql} from "./acs-create-label.server";
import {isPosOrder, orderIdentity, matchesOrderSearch} from "./order-display";

export function orderContactFields(access) {
  return `${access.email ? "email" : ""}
    ${access.customer ? `customer { id ${access.customerName ? "displayName" : ""} }` : ""}
    shippingAddress { name address1 address2 city zip countryCodeV2 ${access.phone ? "phone" : ""} }`;
}

// Email approval can lag behind deployment. Retry only protected-data denials,
// leaving the order/fulfillment query and unrelated API errors intact.
export async function withOrderContacts(admin, queryFor, variables) {
  const access = {email:true, phone:true, customer:true, customerName:true};
  for (;;) {
    try {
      const response = await adminGraphql(admin, queryFor(orderContactFields(access)), variables);
      return {...response, contactAccessLimited: !access.email || !access.phone || !access.customerName || !access.customer};
    } catch (error) {
      if (!/protected customer data|not approved to access|access denied|access_denied|read_customers/i.test(error.message)) throw error;
      if (/email/i.test(error.message) && access.email) access.email=false;
      else if (/phone/i.test(error.message) && access.phone) access.phone=false;
      else if (/Customer object|customer field|read_customers/i.test(error.message) && access.customer) access.customer=false;
      else if (access.email) access.email=false;
      else if (access.phone) access.phone=false;
      else if (access.customerName) access.customerName=false;
      else if (access.customer) access.customer=false;
      else throw error;
    }
  }
}

export function searchTerm(query) {
  return `"${String(query).replace(/\\/g,"\\\\").replace(/"/g,'\\"')}"`;
}

export function shopifyOrderSearchFilter(query) {
  if (!query) return "";
  const term=searchTerm(query), number=searchTerm(query.replace(/^#/, ""));
  return `(name:${number} OR email:${term} OR ${term})`;
}

export async function matchingShopifyOrders(admin, query) {
  if (!query) return {orders:[], contactAccessLimited:false};
  const filter=`-source_name:pos ${shopifyOrderSearchFilter(query)}`;
  const orders=[];
  let after=null, contactAccessLimited=false;
  for (let page=0;page<2;page++) {
    const response=await withOrderContacts(admin, fields=>`query($filter:String!,$after:String){orders(first:100,after:$after,query:$filter,sortKey:CREATED_AT,reverse:true){pageInfo{hasNextPage endCursor} nodes{id name sourceName ${fields}}}}`,{filter,after});
    contactAccessLimited ||= response.contactAccessLimited;
    orders.push(...response.data.orders.nodes.filter(order=>!isPosOrder(order) && matchesOrderSearch({...order,...orderIdentity(order)},query)));
    if (!response.data.orders.pageInfo.hasNextPage) break;
    after=response.data.orders.pageInfo.endCursor;
  }
  return {orders,contactAccessLimited};
}

export function shipmentSearchWhere(query, orderIds, includeSource=false) {
  if (!query) return {};
  return {OR:[...(["orderName","recipientName","customerName","customerEmail"].map(field=>({[field]:{contains:query,mode:"insensitive"}}))),
    {orderId:{in:orderIds}}, ...(includeSource?[{sourceOrderId:{in:orderIds}}]:[])]};
}

export async function enrichShipmentOrders(admin, db, shop, rows, knownOrders=[]) {
  const byId=new Map(knownOrders.map(order=>[order.id,order]));
  const ids=[...new Set(rows.filter(row=>!row.trackingDetailsPurgedAt && (!row.orderSourceName || !row.customerEmail || !row.addressPreview || !row.recipientName))
    .map(row=>row.sourceOrderId||row.orderId).filter(id=>/^gid:\/\/shopify\/Order\/\d+$/.test(id||"")))].filter(id=>!byId.has(id));
  let contactAccessLimited=false;
  for (let i=0;i<ids.length;i+=100) {
    const response=await withOrderContacts(admin, fields=>`query($ids:[ID!]!){nodes(ids:$ids){... on Order {id name sourceName ${fields}}}}`,{ids:ids.slice(i,i+100)});
    contactAccessLimited ||= response.contactAccessLimited;
    for (const order of response.data.nodes.filter(Boolean)) byId.set(order.id,order);
  }
  const updates=[];
  for (const [id,order] of byId) {
    const linked=rows.filter(row=>!row.trackingDetailsPurgedAt && (row.sourceOrderId||row.orderId)===id);
    if (!linked.length) continue;
    // Keep the label's recipient/address as issued; customer identity is current.
    const details=orderIdentity(order);
    for (const row of linked) {
      const patch={...details};
      for (const key of ["recipientName","recipientPhone","addressPreview","country"]) {
        if (row[key] || !patch[key]) delete patch[key];
      }
      const changed=Object.fromEntries(Object.entries(patch).filter(([key,value])=>row[key]!==value));
      Object.assign(row,changed);
      if (!Object.keys(changed).length || row.id?.startsWith("manual:")) continue;
      if (row.id?.startsWith("snapshot:")) updates.push(db.acsTrackingSnapshot.updateMany({where:{shop,id:row.id.slice(9),trackingDetailsPurgedAt:null},data:changed}));
      else if (row.id?.startsWith("legacy:")) updates.push(db.acsTrackingSnapshot.updateMany({where:{shop,voucherNo:row.voucher,trackingDetailsPurgedAt:null},data:changed}));
      else updates.push(db.courierShipment.updateMany({where:{shop,id:row.id,trackingDetailsPurgedAt:null},data:changed}));
    }
  }
  for (let i=0;i<updates.length;i+=100) await db.$transaction(updates.slice(i,i+100));
  return {rows:rows.filter(row=>!isPosOrder(row)),contactAccessLimited};
}
