import {spawn} from "node:child_process";
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
  return new Promise((resolve,reject)=>{
    const child=spawn("python3",["scripts/packing-slips.py"]);
    const chunks=[];
    child.stdout.on("data",chunk=>chunks.push(chunk));
    child.stderr.resume();
    child.on("error",reject);
    child.stdin.on("error",reject);
    child.on("close",code=>code===0?resolve(Buffer.concat(chunks).toString("base64")):reject(new Error("Packing slip PDF generation failed")));
    child.stdin.end(JSON.stringify(orders));
  });
}
