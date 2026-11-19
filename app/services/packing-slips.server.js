import {shippingDocument} from "./shipping-documents.server";
import {adminGraphql} from "./acs-create-label.server";

export async function packingPdf(admin, ids) {
  const orders=[];
  for (const id of ids) {
    let after=null, order;
    do {
      const {data}=await adminGraphql(admin,`query($id:ID!,$after:String){order(id:$id){name shippingAddress{name company address1 address2 zip city country} lineItems(first:100,after:$after){nodes{name sku currentQuantity unfulfilledQuantity} pageInfo{hasNextPage endCursor}}}}`,{id,after});
      if(!data.order) throw new Error("Order unavailable");
      order??={name:data.order.name,shippingAddress:data.order.shippingAddress,items:[]};
      order.items.push(...data.order.lineItems.nodes);
      after=data.order.lineItems.pageInfo.hasNextPage?data.order.lineItems.pageInfo.endCursor:null;
    } while(after);
    if(order.items.some(item=>item.unfulfilledQuantity>0))for(const item of order.items)item.currentQuantity=item.unfulfilledQuantity;
    orders.push(order);
  }
  return renderPdf("scripts/packing-slips.py",orders);
}

export function renderPdf(script,payload){
  const kinds={"scripts/packing-slips.py":"packing","scripts/geniki-handover.py":"handover"};
  return shippingDocument(kinds[script],payload);
}
