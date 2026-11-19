import {shippingDocument} from "./shipping-documents.server";
import {adminGraphql} from "./acs-create-label.server";
import {withOrderContacts} from './shopify-order-details.server';
import {packingTemplate,packingContext,packingHtml} from './packing-slip-template.server';
import {renderPackingPdfs} from './packing-slip-renderer.server';

export const packingShopQuery=`query PackingShop{shop{name email myshopifyDomain primaryDomain{host} shopAddress{address1 address2 city zip country countryCodeV2}}}`;
export const packingOrderQuery=fields=>`query PackingOrder($id:ID!,$after:String){order(id:$id){id name createdAt poNumber note tags displayFinancialStatus ${fields}
  shippingAddress{company country provinceCode} billingAddress{name company address1 address2 city zip country countryCodeV2 provinceCode ${fields.includes('phone')?'phone':''}}
  ${fields.includes('customer {')?'customer{numberOfOrders}':''}
  lineItems(first:100,after:$after){nodes{id title variantTitle sku currentQuantity quantity unfulfilledQuantity image{url} customAttributes{key value} lineItemGroup{title}} pageInfo{hasNextPage endCursor}}
  fulfillments(first:100){id status}
}}`;

export async function packingPdf(admin, ids) {
  if(!ids.length||ids.length>50)throw new Error('Select between 1 and 50 orders to print packing slips.');
  const {data:{shop}}=await adminGraphql(admin,packingShopQuery,{});
  const template=await packingTemplate(admin,shop.myshopifyDomain,adminGraphql);
  const documents=[],historyCache=new Map();
  for(const id of [...new Set(ids)]){
    let after=null,order;
    do{
      const {data}=await withOrderContacts(admin,packingOrderQuery,{id,after});
      if(!data.order)throw new Error('Order unavailable for packing slip printing.');
      if(!order)order={...data.order,lineItems:{nodes:[]}};
      order.lineItems.nodes.push(...data.order.lineItems.nodes);
      after=data.order.lineItems.pageInfo.hasNextPage?data.order.lineItems.pageInfo.endCursor:null;
    }while(after);
    if(!order.lineItems.nodes.some(i=>i.unfulfilledQuantity>0)){
      order.fulfilledQuantities={};
      for(const f of order.fulfillments.filter(f=>f.status!=='CANCELLED'&&f.status!=='FAILURE')){
        let cursor=null;
        do{
          const {data}=await adminGraphql(admin,`query PackingFulfillment($id:ID!,$after:String){fulfillment(id:$id){fulfillmentLineItems(first:100,after:$after){nodes{quantity lineItem{id}} pageInfo{hasNextPage endCursor}}}}`,{id:f.id,after:cursor});
          if(!data.fulfillment)throw new Error('Shipment items unavailable for packing slip reprinting.');
          const items=data.fulfillment.fulfillmentLineItems;
          for(const item of items.nodes)order.fulfilledQuantities[item.lineItem.id]=Math.max(order.fulfilledQuantities[item.lineItem.id]||0,item.quantity);
          cursor=items.pageInfo.hasNextPage?items.pageInfo.endCursor:null;
        }while(cursor);
      }
    }
    let history=[];
    if(order.customer&&Number(order.customer.numberOfOrders)>1){
      if(!historyCache.has(order.customer.id)){
        const {data}=await adminGraphql(admin,`query PackingHistory($id:ID!){customer(id:$id){orders(first:4,sortKey:CREATED_AT,reverse:true){nodes{id name lineItems(first:100){nodes{title} pageInfo{hasNextPage endCursor}}}}}}`,{id:order.customer.id});
        const previous=data.customer?.orders.nodes||[];
        for(const old of previous){
          let page=old.lineItems.pageInfo;
          while(page.hasNextPage){
            const {data}=await adminGraphql(admin,`query PackingHistoryItems($id:ID!,$after:String){order(id:$id){lineItems(first:100,after:$after){nodes{title} pageInfo{hasNextPage endCursor}}}}`,{id:old.id,after:page.endCursor});
            old.lineItems.nodes.push(...data.order.lineItems.nodes);page=data.order.lineItems.pageInfo;
          }
        }
        historyCache.set(order.customer.id,previous);
      }
      history=historyCache.get(order.customer.id);
    }
    documents.push(await packingHtml(template,packingContext(order,shop,history,template.locale)));
  }
  return (await renderPackingPdfs(documents)).toString('base64');
}

export function renderPdf(script,payload){
  const kinds={"scripts/packing-slips.py":"packing","scripts/geniki-handover.py":"handover"};
  return shippingDocument(kinds[script],payload);
}
