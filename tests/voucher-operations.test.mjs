import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const directory=await mkdtemp(join(tmpdir(),"courier-vouchers-"));
const bridges={
  "db.server":"export default globalThis.__voucherTest.db;",
  "acs-create-label.server":`export const todayYMD=()=>"2026-11-19";export const adminGraphql=(a,q,v)=>a.execute(q,v);export const createOrReuseAcsLabel=o=>globalThis.__voucherTest.acsCreate(o);`,
  "acs.server":"export const deleteAcsVoucher=n=>globalThis.__voucherTest.cancelAcs(n);",
  "geniki.server":`export const genikiLive=globalThis.__voucherTest.api;export const genikiSandbox=genikiLive;export const isCourierTestShop=()=>false;export function genikiParcelNumbers(main,records,count){const ns=[...new Set([main,...[records].flat().map(r=>r?.VoucherNo)].filter(Boolean))];if(ns.length<count)throw new Error("Missing parcel numbers");return ns;}`,
  "shopify-order-details.server":`export const withOrderContacts=(a,q,v)=>a.execute(q("shippingAddress{name address1 address2 countryCodeV2 city zip phone}"),v);`,
};
await build({entryPoints:[new URL("../app/services/voucher-operations.server.js",import.meta.url).pathname],outfile:join(directory,"operations.mjs"),bundle:true,platform:"node",format:"esm",plugins:[{name:"boundaries",setup(b){b.onResolve({filter:/\/(db\.server|acs-create-label\.server|acs\.server|geniki\.server|shopify-order-details\.server)$/},args=>({path:args.path.split("/").at(-1),namespace:"test"}));b.onLoad({filter:/.*/,namespace:"test"},args=>({contents:bridges[args.path],loader:"js"}));}}]});
let moduleNumber=0;
function fixture({prior,orderPatch={},cancelError=false,trackingError=false,partial=false}={}){
  const shop="operations.myshopify.com",events=[],rows=prior?[structuredClone(prior)]:[];
  const originalTracking=[{number:"OLD",url:"https://original/OLD",company:"Geniki"},{number:"OTHER",url:"https://other/OTHER",company:"Other courier"}];
  const order={id:"gid://shopify/Order/1",name:"#WB-4682",sourceName:"web",test:false,displayFulfillmentStatus:"FULFILLED",tags:["COD"],paymentGatewayNames:[],totalOutstandingSet:{shopMoney:{amount:"0",currencyCode:"EUR"}},shippingAddress:{name:"Test recipient",address1:"Test street 1",city:"Test city",zip:"12345",countryCodeV2:"GR"},fulfillments:[{id:"gid://shopify/Fulfillment/1",status:"SUCCESS",trackingInfo:originalTracking}],...orderPatch};
  const matches=(row,w)=>Object.entries(w||{}).every(([k,v])=>typeof v==="object"&&v!==null?Object.entries(v).every(([op,x])=>op==="not"?row[k]!==x:true):row[k]===v);
  const model={findFirst:async({where})=>structuredClone(rows.find(r=>matches(r,where))||null),findFirstOrThrow:async args=>{const r=await model.findFirst(args);if(!r)throw new Error("Not found");return r;},create:async({data})=>{
    if(rows.some(r=>r.reference===data.reference||(data.previousId&&r.previousId===data.previousId)))throw new Error("Duplicate operation");
    const r={id:"operation-"+rows.length,...structuredClone(data)};rows.push(r);events.push("store-operation");return structuredClone(r);},
    update:async({where,data})=>{const r=rows.find(r=>matches(r,where));if(!r)throw new Error("Not found");Object.assign(r,structuredClone(data));return structuredClone(r);},
    upsert:async({where,create})=>await model.findFirst({where:where.shop_orderId_environment})||model.create({data:create})};
  const db={courierShipment:model,acsTrackingSnapshot:{findFirst:async()=>null,updateMany:async()=>({count:0})},$executeRaw:async()=>{events.push("tracking-lock");return 1;},$transaction:async cb=>cb(db)};
  let failTracking=trackingError;
  const admin={execute:async(q,v)=>{
    if(q.includes("mutation")){events.push("shopify-tracking");if(failTracking)throw new Error("Shopify temporarily unavailable");order.fulfillments[0].trackingInfo=v.tracking.numbers.map((number,i)=>({number,url:v.tracking.urls?.[i],company:v.tracking.company}));return {data:{fulfillmentTrackingInfoUpdate:{fulfillment:{id:order.fulfillments[0].id},userErrors:[]}}};}
    return q.includes("order(id:")?{data:{order}}:{data:{node:order.fulfillments[0]}};
  }};
  const api={authenticate:async()=>"test-key",cancel:async()=>{events.push("carrier-cancel");if(cancelError)throw new Error("Carrier refused cancellation");},create:async(key,record)=>{events.push({create:record});return {Voucher:"NEW",JobId:"22",SubVouchers:{Record:partial?undefined:[{VoucherNo:"NEW-2"}]}};},lookup:async()=>{events.push("carrier-lookup");return {Count:"1",Jobs:{VoucherJob:{SubVouchers:{Record:[{VoucherNo:"NEW-2"}]}}}};}};
  const boundary={db,api,cancelAcs:async()=>{events.push("carrier-cancel");if(cancelError)throw new Error("Carrier refused cancellation");return {ACSOutputResponce:{ACSValueOutput:[{Error_Message:""}]}};},acsCreate:async options=>{events.push({acs:options});await options.onVoucherCreated({voucherNumber:"NEW",shipmentNumbers:["NEW","NEW-2"]});}};
  const input={mode:"new",orderId:order.id,carrier:"Geniki",token:"12345678-1234-1234-1234-123456789012",pieces:"2",weight:"1.5",cod:"0",pickupDate:"2026-11-20",employee:"Admin",confirm:"on",fulfillmentId:order.fulfillments[0].id};
  return {shop,order,rows,events,admin,boundary,input,allowTracking:()=>{failTracking=false;}};
}
const original={id:"prior",shop:"operations.myshopify.com",orderId:"gid://shopify/Order/1",orderName:"#WB-4682",carrier:"Geniki",environment:"live",status:"Ready for pickup",voucher:"OLD",labels:["OLD"],jobId:"11",fulfillmentId:"gid://shopify/Fulfillment/1",country:"GR"};
async function load(f){globalThis.__voucherTest=f.boundary;return import(new URL("file://"+join(directory,"operations.mjs")+"?"+(moduleNumber++)));}

test("New voucher appends tracking, retains old vouchers and prints the order reference in carrier comments",async()=>{
  const f=fixture(),m=await load(f),r=await m.issueOrderVoucher(f.admin,f.shop,f.input);
  assert.equal(f.events.includes("carrier-cancel"),false);
  const record=f.events.find(e=>e.create).create;
  assert.equal(record.Comments,"Order #WB-4682");assert.equal(record.Pieces,2);assert.equal(record.ReceivedDate,"2026-11-20T12:00:00");assert.equal(record.CodAmount,0);
  assert.deepEqual(f.order.fulfillments[0].trackingInfo.map(t=>t.number),["OLD","OTHER","NEW","NEW-2"]);
  assert.equal(f.order.displayFulfillmentStatus,"FULFILLED");assert.equal(f.order.fulfillments[0].status,"SUCCESS");assert.equal(r.fulfillmentPlan.trackingSynced,true);
});
test("Replace cancels before creation and replaces only the selected tracking",async()=>{
  const f=fixture({prior:original}),m=await load(f);
  await m.issueOrderVoucher(f.admin,f.shop,{...f.input,mode:"replace",shipmentId:"prior"});
  assert.ok(f.events.indexOf("carrier-cancel")<f.events.findIndex(e=>e.create));
  assert.equal(f.rows.find(r=>r.id==="prior").status,"Cancelled");
  assert.deepEqual(f.order.fulfillments[0].trackingInfo.map(t=>t.number),["OTHER","NEW","NEW-2"]);
});
test("a refused cancellation never creates a replacement or changes Shopify tracking",async()=>{
  const f=fixture({prior:original,cancelError:true}),m=await load(f);
  await assert.rejects(m.issueOrderVoucher(f.admin,f.shop,{...f.input,mode:"replace",shipmentId:"prior"}),/Carrier refused cancellation/);
  assert.equal(f.events.some(e=>e.create),false);assert.equal(f.events.includes("shopify-tracking"),false);assert.equal(f.rows[0].status,"Ready for pickup");
});
test("a returned voucher requires New voucher rather than cancellation and replacement",async()=>{
  const f=fixture({prior:{...original,status:"RETURNED"}}),m=await load(f);
  await assert.rejects(m.issueOrderVoucher(f.admin,f.shop,{...f.input,mode:"replace",shipmentId:"prior"}),/Use New voucher/);
  assert.equal(f.events.length,0);
});
test("duplicate submissions reuse the issued voucher without another carrier request",async()=>{
  const f=fixture(),m=await load(f);await m.issueOrderVoucher(f.admin,f.shop,f.input);await m.issueOrderVoucher(f.admin,f.shop,f.input);
  assert.equal(f.events.filter(e=>e.create).length,1);assert.equal(f.events.filter(e=>e==="shopify-tracking").length,1);
});
test("tracking failure preserves the issued voucher and retries only Shopify",async()=>{
  const f=fixture({trackingError:true}),m=await load(f);let error;
  try{await m.issueOrderVoucher(f.admin,f.shop,f.input);}catch(e){error=e;}
  assert.match(error.message,/Voucher NEW was created/);assert.ok(error.operationId);assert.equal(f.rows[0].voucher,"NEW");
  f.allowTracking();await m.finishVoucherTracking(f.admin,f.shop,error.operationId);
  assert.equal(f.events.filter(e=>e.create).length,1);assert.equal(f.rows[0].status,"Ready for pickup");
});
test("missing Geniki parcel numbers are recovered using the existing request reference",async()=>{
  const f=fixture({partial:true}),m=await load(f);await m.issueOrderVoucher(f.admin,f.shop,f.input);
  assert.equal(f.events.filter(e=>e.create).length,1);assert.ok(f.events.includes("carrier-lookup"));assert.deepEqual(f.rows[0].labels,["NEW","NEW-2"]);
});
test("additional ACS vouchers bypass reuse and preserve previous Shopify tracking",async()=>{
  const f=fixture(),m=await load(f);await m.issueOrderVoucher(f.admin,f.shop,{...f.input,carrier:"ACS"});
  const o=f.events.find(e=>e.acs).acs;assert.equal(o.forceNew,true);assert.equal(o.skipShopifySync,true);assert.equal(o.weight,1.5);
  assert.deepEqual(f.order.fulfillments[0].trackingInfo.map(t=>t.number),["OLD","OTHER","NEW","NEW-2"]);
});
test("COD is restricted to Greece and calendar dates, weight and parcel count are validated before submission",async()=>{
  const f=fixture(),m=await load(f);
  for(const patch of [{pieces:"0"},{weight:"NaN"},{cod:""},{pickupDate:"2026-02-30"},{pickupDate:"2026-11-18"}])assert.throws(()=>m.validateVoucherOptions(f.order,"new",null,{...f.input,...patch}));
  assert.throws(()=>m.validateVoucherOptions({...f.order,shippingAddress:{countryCodeV2:"CY"}},"new",null,{...f.input,cod:"10"}),/Greece/);
});
test("an issued operation from another shop cannot be synchronized",async()=>{
  const f=fixture({prior:original}),m=await load(f);await assert.rejects(m.finishVoucherTracking(f.admin,"another.myshopify.com","prior"),/Not found/);assert.equal(f.events.length,0);
});
test.after(async()=>{delete globalThis.__voucherTest;await rm(directory,{recursive:true,force:true});});
