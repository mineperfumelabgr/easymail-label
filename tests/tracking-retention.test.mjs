import test from "node:test";
import assert from "node:assert/strict";
import {Prisma} from "@prisma/client";
import {trackingRetentionCutoff,confirmedCompletionDate} from "../app/services/tracking-retention.js";
import {compactOldTracking} from "../app/services/tracking-retention.server.js";

const now=new Date("2026-11-19T12:00:00Z"), old=new Date("2025-10-01T12:00:00Z");
const contacts={recipientName:"Recipient",customerName:"Customer",customerEmail:"customer@example.test",recipientPhone:"123",addressPreview:"Example address"};
const shipment=(id,extra={})=>({id,shop:"sample.myshopify.com",carrier:"Geniki",environment:"live",voucher:id,labels:[id,id+"-2"],
  reference:"reference-"+id,jobId:"job-"+id,orderId:"gid://shopify/Order/123",customerId:"gid://shopify/Customer/456",
  fulfillmentId:"gid://shopify/Fulfillment/789",country:"GR",pieces:2,codAmount:25,preparedBy:"Employee",
  status:"DELIVERED",genikiTerminalSynced:true,completedAt:old,createdAt:new Date("2024-01-01"),
  trackingDetailsPurgedAt:null,returnPending:false,returnSerial:null,fulfillmentPlan:[{id:"plan"}],...contacts,...extra});
const snapshot=(id,extra={})=>({id,shop:"sample.myshopify.com",voucherNo:id,status:"DELIVERED",statusLabel:"Delivered",
  lastShopifyEventStatus:"DELIVERED",completedAt:old,trackingDetailsPurgedAt:null,error:null,
  reasonCode:"reason",lastCheckpoint:"checkpoint",lastLocation:"location",orderId:"gid://shopify/Order/123",
  fulfillmentId:"gid://shopify/Fulfillment/789",...contacts,...extra});

// Generic in-memory Prisma boundary; eligibility remains the production query.
function matches(row,where={}) {
  return Object.entries(where).every(([key,value])=>{
    if(key==="OR")return value.some(w=>matches(row,w));
    if(key==="AND")return value.every(w=>matches(row,w));
    if(key==="NOT")return !matches(row,value);
    const actual=row[key];
    if(value===null)return actual==null;
    if(value instanceof Date)return actual instanceof Date && actual.getTime()===value.getTime();
    if(typeof value!=="object")return actual===value;
    return Object.entries(value).every(([op,target])=>op==="in"?target.includes(actual):op==="notIn"?!target.includes(actual):op==="not"?actual!==target:op==="lt"?actual!=null && actual<target:false);
  });
}
function database(snapshots=[],shipments=[]) {
  const updates=[];
  const model=rows=>({
    findMany:async({where,select,take,orderBy})=>{
      let result=rows.filter(row=>matches(row,where));
      if(orderBy?.completedAt)result=[...result].sort((a,b)=>a.completedAt-b.completedAt);
      if(take)result=result.slice(0,take);
      return result.map(row=>Object.fromEntries(Object.keys(select||row).map(k=>[k,row[k]])));
    },
    updateMany:async({where,data})=>{
      db.beforeUpdate?.(rows,where,data);
      const found=rows.filter(row=>matches(row,where));
      for(const row of found)for(const [key,value] of Object.entries(data))row[key]=value===Prisma.DbNull?null:value;
      updates.push({where,data,count:found.length});
      return {count:found.length};
    },
  });
  const db={acsTrackingSnapshot:model(snapshots),courierShipment:model(shipments),updates,$transaction:async callback=>callback(db)};
  return db;
}

test("retention uses calendar months and clamps leap day without mutating the clock",()=>{
  assert.equal(trackingRetentionCutoff(now).toISOString(),"2025-11-19T12:00:00.000Z");
  assert.equal(trackingRetentionCutoff(new Date("2028-02-29T10:12:13Z")).toISOString(),"2027-02-28T10:12:13.000Z");
  assert.equal(now.toISOString(),"2026-11-19T12:00:00.000Z");
});

test("unknown, default SOAP and future delivery dates start from observation instead of creation",()=>{
  for(const value of [null,"invalid","0001-01-01T00:00:00Z","2030-01-01T00:00:00Z"])
    assert.equal(confirmedCompletionDate(value,now).getTime(),now.getTime());
  assert.equal(confirmedCompletionDate(old,now).getTime(),old.getTime());
});

test("compaction preserves voucher/fulfillment references and protects active, unsynced and return records",async()=>{
  const snapshots=[snapshot("acs-old"),snapshot("acs-pending-return",{status:"RETURNED",lastShopifyEventStatus:"FAILURE"}),
    snapshot("acs-active",{status:"IN_TRANSIT"}),snapshot("acs-problem",{status:"DELIVERY_DELAYED"}),
    snapshot("acs-error",{error:"Needs retry"}),snapshot("acs-unsynced",{lastShopifyEventStatus:"IN_TRANSIT"}),
    snapshot("acs-unknown-date",{completedAt:null}),snapshot("acs-recent-completion",{completedAt:now}),
    snapshot("acs-returned",{status:"RETURNED",lastShopifyEventStatus:"FAILURE"})];
  const shipments=[shipment("acs-core",{carrier:"ACS",voucher:"acs-old",status:"Label generated",completedAt:null}),
    shipment("acs-return-core",{carrier:"ACS",voucher:"acs-pending-return",returnPending:true}),
    shipment("geniki-old"),shipment("geniki-manual",{fulfillmentId:null}),shipment("geniki-returned",{status:"RETURN TO SENDER"}),
    shipment("geniki-pending",{returnPending:true}),shipment("geniki-coupon",{returnSerial:"coupon"}),
    shipment("geniki-unsynced",{genikiTerminalSynced:false}),shipment("geniki-active",{status:"IN TRANSIT"}),
    shipment("geniki-returning",{status:"IN RETURN"}),shipment("geniki-recent",{completedAt:now}),
    shipment("geniki-unknown-date",{completedAt:null}),shipment("geniki-test",{environment:"test"}),
    shipment("another-shop",{shop:"another.myshopify.com"})];
  const db=database(snapshots,shipments), result=await compactOldTracking(db,"sample.myshopify.com",now);
  assert.equal(result.acsCompacted,2);assert.equal(result.acsLabelRecordsCompacted,1);assert.equal(result.genikiCompacted,3);
  for(const row of shipments.filter(row=>row.trackingDetailsPurgedAt)){
    assert.equal(row.customerEmail,null);assert.equal(row.fulfillmentPlan,null);
    assert.equal(row.voucher,row.id==="acs-core"?"acs-old":row.id);
    assert.deepEqual(row.labels,[row.id,row.id+"-2"]);assert.equal(row.jobId,"job-"+row.id);
    assert.equal(row.orderId,"gid://shopify/Order/123");assert.equal(row.customerId,"gid://shopify/Customer/456");
    assert.equal(row.pieces,2);assert.equal(row.codAmount,25);assert.equal(row.preparedBy,"Employee");
  }
  for(const row of [...snapshots,...shipments].filter(row=>!row.trackingDetailsPurgedAt))assert.equal(row.customerEmail,"customer@example.test",row.id);
  const again=await compactOldTracking(db,"sample.myshopify.com",now);
  assert.equal(again.acsCompacted+again.acsLabelRecordsCompacted+again.genikiCompacted,0);
  assert.equal(snapshots.length,9);assert.equal(shipments.length,14);
});

test("a return opened after candidate selection is rechecked on write",async()=>{
  const row=shipment("racing-return"),db=database([],[row]);
  db.beforeUpdate=()=>{row.returnPending=true};
  const result=await compactOldTracking(db,"sample.myshopify.com",now);
  assert.equal(result.genikiCompacted,0);assert.equal(row.customerEmail,"customer@example.test");
});

test("an ACS return starting during compaction protects both snapshot and label details",async()=>{
  const record=snapshot("acs-race"),label=shipment("label-race",{carrier:"ACS",voucher:"acs-race"});
  const db=database([record],[label]);
  db.beforeUpdate=rows=>{if(rows.includes(label))label.returnPending=true};
  const result=await compactOldTracking(db,"sample.myshopify.com",now);
  assert.equal(result.acsCompacted,0);assert.equal(result.acsLabelRecordsCompacted,0);
  assert.equal(record.customerEmail,"customer@example.test");assert.equal(label.customerEmail,"customer@example.test");
});

test("long-unfulfilled labels are never aged out by their creation date",async()=>{
  const row=shipment("long-open",{createdAt:new Date("2020-01-01"),completedAt:null,status:"Ready for pickup",genikiTerminalSynced:false});
  const result=await compactOldTracking(database([],[row]),"sample.myshopify.com",now);
  assert.equal(result.genikiCompacted,0);assert.equal(row.customerEmail,"customer@example.test");
});

test("each pass is bounded and a protected ACS backlog cannot starve eligible records",async()=>{
  const rows=Array.from({length:450},(_,i)=>shipment("g"+i));
  const db=database([],rows);
  assert.equal((await compactOldTracking(db,"sample.myshopify.com",now)).genikiCompacted,200);
  assert.equal(rows.filter(r=>r.trackingDetailsPurgedAt).length,200);
  const snapshots=Array.from({length:220},(_,i)=>snapshot("a"+i));
  const protectedRows=Array.from({length:210},(_,i)=>shipment("p"+i,{carrier:"ACS",voucher:"a"+i,returnPending:true}));
  assert.equal((await compactOldTracking(database(snapshots,protectedRows),"sample.myshopify.com",now)).acsCompacted,10);
});
