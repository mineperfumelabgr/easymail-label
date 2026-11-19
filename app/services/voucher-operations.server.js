import {randomUUID} from "node:crypto";
import db from "../db.server";
import {adminGraphql,createOrReuseAcsLabel,todayYMD} from "./acs-create-label.server";
import {deleteAcsVoucher} from "./acs.server";
import {genikiLive,genikiSandbox,genikiParcelNumbers,isCourierTestShop,genikiJobFromLookup} from "./geniki.server";
import {withOrderContacts} from "./shopify-order-details.server";
import {isPosOrder,orderIdentity} from "./order-display";
import {collectionAmount} from "./order-cod";
import {courierTrackingUrl} from "./courier-tracking";

export const operationQuery=fields=>`query($id:ID!){order(id:$id){id name sourceName test cancelledAt displayFulfillmentStatus tags paymentGatewayNames totalOutstandingSet{shopMoney{amount currencyCode}} acsPieces:metafield(namespace:"acs",key:"pieces"){value} acsNumbers:metafield(namespace:"acs",key:"current_numbers"){value} ${fields} fulfillments(first:100){id status trackingInfo{number url company}}}}`;
const numbers=row=>[...new Set((row.labels||[row.voucher]).filter(Boolean).map(String))];
const isOrder=id=>/^gid:\/\/shopify\/Order\/\d+$/.test(id||"");

export function trackingForOperation(existing,newNumbers,carrier,removed=[]){
  const exclude=new Set([...removed,...newNumbers]);
  const keep=existing.filter(t=>t.number&&!exclude.has(t.number));
  const all=[...keep,...newNumbers.map(number=>({number,url:courierTrackingUrl(carrier,number),company:carrier}))];
  const payload={numbers:all.map(t=>t.number)};
  if(all.every(t=>t.url))payload.urls=all.map(t=>t.url);
  if(keep.every(t=>!t.company||new RegExp(carrier,"i").test(t.company)))payload.company=carrier==="ACS"?"ACS Courier":"Geniki Tachydromiki";
  return payload;
}

export async function operationContext(admin,shop,{orderId,shipmentId,voucher,carrier,mode="new"}){
  let prior=shipmentId?await db.courierShipment.findFirst({where:{id:shipmentId,shop}}):null;
  if(shipmentId&&!prior)throw new Error("Shipment unavailable. Reload Daily Labels.");
  orderId=prior?.sourceOrderId||prior?.orderId||orderId;
  if(!isOrder(orderId))throw new Error("Choose a shipment linked to a Shopify order.");
  const {data}=await withOrderContacts(admin,operationQuery,{id:orderId});
  const order=data.order;
  if(!order||isPosOrder(order)||order.cancelledAt||!order.shippingAddress)throw new Error("This order cannot be shipped.");
  if(!prior&&mode==="replace"){
    if(carrier!=="ACS"||!/^\d+$/.test(voucher||""))throw new Error("Choose the original voucher in Daily Labels.");
    const snapshot=await db.acsTrackingSnapshot.findFirst({where:{shop,orderId,voucherNo:voucher}});
    const fulfillment=order.fulfillments.find(f=>f.status!=="CANCELLED"&&f.trackingInfo.some(t=>t.number===voucher));
    if(!fulfillment)throw new Error("Original voucher is no longer attached to this order. Reload the page.");
    let labels=[voucher];
    try{const parsed=JSON.parse(order.acsNumbers?.value||"[]");if(Array.isArray(parsed)&&parsed.includes(voucher))labels=parsed.map(String);}catch{/* Keep the confirmed main voucher. */}
    prior={id:null,orderId,shop,carrier:"ACS",environment:"live",voucher,labels,pieces:Number(order.acsPieces?.value)||1,fulfillmentId:fulfillment.id,status:snapshot?.status||"Issued",orderName:order.name,country:order.shippingAddress.countryCodeV2,createdAt:snapshot?.fulfillmentCreatedAt||undefined};
  }
  if(mode==="replace"&&(!prior?.voucher||["Cancelled","Superseded","DELIVERED","RETURNED","RETURN TO SENDER"].includes(prior.status)))throw new Error("This voucher cannot be replaced. Use New voucher for a fresh shipment.");
  const fulfillments=order.fulfillments.filter(f=>f.status!=="CANCELLED");
  if(!fulfillments.length)throw new Error("No active Shopify fulfillment exists. Prepare the order normally first.");
  if(mode==="replace"&&!fulfillments.some(f=>f.id===prior.fulfillmentId&&f.trackingInfo.some(t=>numbers(prior).includes(t.number))))throw new Error("The original tracking has changed. Reload the shipment before replacing it.");
  return {order,prior,fulfillments,defaultCod:collectionAmount(order,null,null)};
}

export function validateVoucherOptions(order,mode,prior,input){
  const carrier=mode==="replace"?prior.carrier:input.carrier;
  const pieces=Number(input.pieces),weight=Number(input.weight),cod=Number(input.cod);
  if(!["ACS","Geniki"].includes(carrier))throw new Error("Choose ACS or Geniki.");
  if(!Number.isInteger(pieces)||pieces<1||pieces>5)throw new Error("Choose 1–5 parcels.");
  if(!Number.isFinite(weight)||weight<=0)throw new Error("Enter a positive packed weight.");
  if(input.cod===""||!Number.isFinite(cod)||cod<0)throw new Error("Enter COD in EUR, or 0 for no collection.");
  if(cod>0&&order.shippingAddress.countryCodeV2!=="GR")throw new Error("COD is available for Greece only.");
  const pickupDate=String(input.pickupDate||"");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)||!Number.isFinite(Date.parse(pickupDate+"T12:00:00Z"))||new Date(pickupDate+"T12:00:00Z").toISOString().slice(0,10)!==pickupDate||pickupDate<todayYMD())throw new Error("Choose today or a future pickup date in the calendar.");
  return {carrier,pieces,weight,cod,pickupDate};
}

export async function finishVoucherTracking(admin,shop,id){
  let row=await db.courierShipment.findFirstOrThrow({where:{id,shop}});
  const plan=row.fulfillmentPlan;
  if(!plan?.operation||!row.voucher||!row.fulfillmentId)throw new Error("No issued voucher is ready to sync.");
  if(["Cancelled","Superseded"].includes(row.status))throw new Error("This voucher is no longer active.");
  if(plan.trackingSynced)return row;
  if(row.carrier==="Geniki"&&numbers(row).length<(row.pieces||1)){
    const api=row.environment==="test"?genikiSandbox:genikiLive;
    const found=await api.lookup(await api.authenticate(),row.reference);
    const job=genikiJobFromLookup(found,row.reference,row.voucher);
    if(!job)throw new Error("Verify the existing Geniki voucher before syncing tracking.");
    row=await db.courierShipment.update({where:{id:row.id},data:{labels:genikiParcelNumbers(row.voucher,job.SubVouchers?.Record,row.pieces)}});
  }
  return db.$transaction(async tx=>{
  // Serialize append/replace requests sharing a fulfillment, including requests
  // handled by different Render instances. Re-read tracking after the lock.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shop+":"+row.fulfillmentId})::bigint)`;
  const {data}=await adminGraphql(admin,`query($id:ID!){node(id:$id){... on Fulfillment{id status trackingInfo{number url company}}}}`,{id:row.fulfillmentId});
  const fulfillment=data.node;
  if(!fulfillment||fulfillment.status==="CANCELLED")throw new Error("Shopify fulfillment is no longer active. Voucher exists; review it before continuing.");
  const tracking=trackingForOperation(fulfillment.trackingInfo,numbers(row),row.carrier,plan.operation==="replace"?plan.previousNumbers:[]);
  const result=await adminGraphql(admin,`mutation($id:ID!,$tracking:FulfillmentTrackingInput!){fulfillmentTrackingInfoUpdate(fulfillmentId:$id,trackingInfoInput:$tracking,notifyCustomer:false){fulfillment{id} userErrors{message}}}`,{id:fulfillment.id,tracking});
  const payload=result.data.fulfillmentTrackingInfoUpdate;
  if(!payload.fulfillment||payload.userErrors.length)throw new Error(payload.userErrors.map(e=>e.message).join(" · ")||"Tracking update was not confirmed.");
  // No fulfillment creation, cancellation, or delivery-status mutation is used here.
  return tx.courierShipment.update({where:{id:row.id},data:{status:"Ready for pickup",fulfillmentPlan:{...plan,trackingSynced:true}}});
  },{timeout:60000});
}

export async function issueOrderVoucher(admin,shop,input){
  const mode=input.mode;
  if(!["new","replace"].includes(mode)||input.confirm!=="on")throw new Error("Confirm the voucher action first.");
  if(!/^[a-f0-9-]{36}$/.test(input.token||""))throw new Error("Invalid operation. Reload this page.");
  // The form token identifies one operation; duplicate submissions never issue twice.
  let row=await db.courierShipment.findFirst({where:{shop,reference:input.token}});
  if(row?.voucher)return finishVoucherTracking(admin,shop,row.id);
  if(row)throw new Error("This request is already being processed or requires verification. Open Daily Labels; do not submit another voucher.");
  const {order,prior,fulfillments}=await operationContext(admin,shop,input);
  const options=validateVoucherOptions(order,mode,prior,input);
  const environment=order.test||isCourierTestShop(shop)?"test":"live";
  if(options.carrier==="ACS"&&environment==="test")throw new Error("ACS real vouchers are disabled for test orders.");
  const fulfillment=mode==="replace"?fulfillments.find(f=>f.id===prior.fulfillmentId):fulfillments.find(f=>f.id===input.fulfillmentId);
  if(!fulfillment)throw new Error("Choose the Shopify fulfillment to attach the tracking to.");
  let previousId=prior?.id;
  if(mode==="replace"&&!previousId){
    const original=await db.courierShipment.upsert({where:{shop_orderId_environment:{shop,orderId:"legacy:"+prior.voucher,environment}},
      create:{shop,orderId:"legacy:"+prior.voucher,sourceOrderId:order.id,orderName:order.name,carrier:prior.carrier,country:prior.country,environment,reference:randomUUID(),voucher:prior.voucher,labels:prior.labels,pieces:prior.pieces,createdAt:prior.createdAt,fulfillmentId:fulfillment.id,status:prior.status},update:{}});
    previousId=original.id;
  }
  if(mode==="replace"&&await db.courierShipment.findFirst({where:{shop,previousId}}))throw new Error("A replacement request already exists. Review it in Daily Labels before issuing again.");
  row=await db.$transaction(async tx=>{
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shop+":"+order.id})::bigint)`;
  const pending=await tx.courierShipment.findFirst({where:{shop,sourceOrderId:order.id,status:{in:["Operation in progress","Cancellation requested","Previous voucher cancelled","Create requested","Label issued · tracking pending"]}}});
  if(pending)throw new Error("An earlier voucher request for this order requires verification or tracking sync. Review Daily Labels before issuing another voucher.");
  return tx.courierShipment.create({data:{shop,orderId:mode+":"+input.token,sourceOrderId:order.id,orderName:order.name,environment,reference:input.token,
    carrier:options.carrier,...orderIdentity(order),country:order.shippingAddress.countryCodeV2,pieces:options.pieces,weight:options.weight,codAmount:options.cod,preparedBy:input.employee,
    previousId:mode==="replace"?previousId:null,fulfillmentId:fulfillment.id,status:"Operation in progress",
    fulfillmentPlan:{operation:mode,pickupDate:options.pickupDate,previousNumbers:prior?numbers(prior):[],options}}});
  });
  const api=environment==="test"?genikiSandbox:genikiLive;
  let submitted=false;
  try{
    const key=options.carrier==="Geniki"?await api.authenticate():null;
    if(mode==="replace"){
      await db.courierShipment.update({where:{id:row.id},data:{status:"Cancellation requested"}});
      if(options.carrier==="Geniki"){
        if(!prior.jobId)throw new Error("Original Geniki job ID is missing; cannot confirm cancellation.");
        await api.cancel(key,prior.jobId);
      }else{
        const response=await deleteAcsVoucher(prior.voucher);
        const envelope=response?.ACSOutputResponce||response?.ACSOutputResponse||{};
        const output=envelope.ACSValueOutput?.[0];
        if(!output||output.Error_Message||output.error_message)throw new Error(output?.Error_Message||output?.error_message||"ACS did not confirm cancellation.");
      }
      await db.courierShipment.update({where:{id:previousId},data:{status:"Cancelled"}});
      if(prior.carrier==="ACS")await db.acsTrackingSnapshot.updateMany({where:{shop,voucherNo:prior.voucher},data:{status:"CANCELLED",statusLabel:"Cancelled",error:null}});
      await db.courierShipment.update({where:{id:row.id},data:{status:"Previous voucher cancelled"}});
    }
    await db.courierShipment.update({where:{id:row.id},data:{status:"Create requested"}});
    submitted=true;
    if(options.carrier==="Geniki"){
      const a=order.shippingAddress;
      const result=await api.create(key,{OrderId:row.reference,Comments:("Order "+order.name).slice(0,40),Name:a.name,Address:[a.address1,a.address2].filter(Boolean).join(" "),CountryIso:a.countryCodeV2,City:a.city,Telephone:a.phone||"",Zip:a.zip,Pieces:options.pieces,Weight:options.weight,Services:options.cod>0?"ΑΜ":"",CodAmount:options.cod,InsAmount:0,ReceivedDate:options.pickupDate+"T12:00:00"});
      if(!result.Voucher||!result.JobId)throw new Error("Geniki has not confirmed the new voucher. Verify the request before retrying.");
      row=await db.courierShipment.update({where:{id:row.id},data:{voucher:result.Voucher,jobId:String(result.JobId),labels:[...new Set([result.Voucher,...[result.SubVouchers?.Record].flat().map(r=>r?.VoucherNo)].filter(Boolean))],status:"Label issued · tracking pending"}});
    }else{
      await createOrReuseAcsLabel({admin,orderGid:order.id,forceNew:true,allowAdditional:true,skipShopifySync:true,pieces:options.pieces,weight:options.weight,codOverride:options.cod>0,codAmountOverride:options.cod,requestedPickupDate:options.pickupDate,
        onVoucherCreated:async result=>{row=await db.courierShipment.update({where:{id:row.id},data:{voucher:result.voucherNumber,labels:result.shipmentNumbers,status:"Label issued · tracking pending"}})}});
    }
    return await finishVoucherTracking(admin,shop,row.id);
  }catch(error){
    // Preserve every issued voucher and ambiguous request for reconciliation.
    // A failure never silently retries the carrier's Create/Cancel operation.
    if(row.voucher){error.message=`Voucher ${row.voucher} was created. ${error.message} Use Retry tracking sync; do not issue another voucher.`;error.operationId=row.id;}
    else error.message=`${mode==="replace"?"Replacement":"New voucher"} not completed. ${error.message}${submitted?" Check the carrier request in Daily Labels before submitting again.":" No new voucher has been confirmed."}`;
    throw error;
  }
}
