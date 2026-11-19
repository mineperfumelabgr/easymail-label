import test from "node:test";
import assert from "node:assert/strict";
import {matchesFulfillmentScope,fulfillmentLabel,matchesOrderSearch,orderIdentity,shopifyAdminLink} from "../app/services/order-display.js";
import {shipmentStatus,matchesTrackingStatus,trackingStatusWhere,trackingStatusChips} from "../app/services/shipment-status.js";
import {courierTrackingUrl} from "../app/services/courier-tracking.js";

test("stale search results cannot place fulfilled or cancelled orders in Unfulfilled",()=>{
  for(const displayFulfillmentStatus of ["FULFILLED","FULFILLMENT_NOT_REQUIRED","ON_HOLD","SCHEDULED"])
    assert.equal(matchesFulfillmentScope({displayFulfillmentStatus},"unfulfilled"),false);
  assert.equal(matchesFulfillmentScope({displayFulfillmentStatus:"UNFULFILLED",cancelledAt:"2026-11-19"},"unfulfilled"),false);
  assert.equal(matchesFulfillmentScope({displayFulfillmentStatus:"UNFULFILLED"},"unfulfilled"),true);
  assert.equal(matchesFulfillmentScope({displayFulfillmentStatus:"PARTIALLY_FULFILLED"},"unfulfilled"),true);
  assert.equal(fulfillmentLabel({displayFulfillmentStatus:"PARTIALLY_FULFILLED"}),"Partially fulfilled");
});

test("POS orders are excluded from every fulfillment tab, including All",()=>{
  for(const scope of ["all","fulfilled","unfulfilled","on_hold"])
    for(const sourceName of ["pos","POS"," pos "])
      assert.equal(matchesFulfillmentScope({sourceName,displayFulfillmentStatus:"FULFILLED"},scope),false);
  assert.equal(matchesFulfillmentScope({sourceName:"shopify_draft_order",displayFulfillmentStatus:"FULFILLED"},"fulfilled"),true);
});

test("search finds order numbers, recipient/customer names and email without case sensitivity",()=>{
  const order={orderName:"#WEB-1234",recipientName:"Maria Example",customerName:"Giorgos Example",customerEmail:"Client@Example.test"};
  for(const q of ["web-1234","MARIA","giorgos"," client@example.test "])assert.equal(matchesOrderSearch(order,q),true);
  assert.equal(matchesOrderSearch(order,"missing"),false);
});

test("a permission-limited response cannot erase a cached email or customer name",()=>{
  const identity=orderIdentity({id:"gid://shopify/Order/123",sourceName:"web",customer:{id:"gid://shopify/Customer/456"},shippingAddress:{name:"Recipient"}});
  assert.equal(Object.hasOwn(identity,"customerEmail"),false);
  assert.equal(Object.hasOwn(identity,"customerName"),false);
  assert.equal(identity.customerId,"gid://shopify/Customer/456");
});

test("links point to the associated Shopify records and reject manual IDs",()=>{
  assert.equal(shopifyAdminLink("sample.myshopify.com","orders","gid://shopify/Order/123"),"https://admin.shopify.com/store/sample/orders/123");
  assert.equal(shopifyAdminLink("sample.myshopify.com","customers","gid://shopify/Customer/456"),"https://admin.shopify.com/store/sample/customers/456");
  for(const id of ["manual:123","replacement:123","gid://shopify/Customer/456","gid://shopify/Order/123/evil"])assert.equal(shopifyAdminLink("sample.myshopify.com","orders",id),null);
  assert.equal(shopifyAdminLink("evil.test","orders","gid://shopify/Order/123"),null);
});

test("legacy ACS labels normalize from canonical codes or historical Italian text",()=>{
  assert.deepEqual(shipmentStatus({carrier:"ACS",statusCode:"DELIVERED",status:"Consegnato al destinatario"}),{code:"DELIVERED",label:"Delivered",tone:"delivered"});
  assert.equal(shipmentStatus({status:"Restituito al mittente"}).tone,"returned");
  assert.equal(shipmentStatus({status:"Returned to sender"}).tone,"returned");
  assert.equal(shipmentStatus({status:"In restituzione al mittente"}).label,"Returning to sender");
  assert.equal(shipmentStatus({status:"Spedito / in transito"}).label,"In transit");
});

test("carrier pickup, transit, delivery problems and terminal returns remain distinct",()=>{
  for(const [status,tone] of [["Ready for pickup","waiting"],["PICKED UP","picked-up"],["IN TRANSIT","transit"],["OUT_FOR_DELIVERY","transit"],["DELIVERY_DELAYED","problem"],["RETURN TO SENDER","returned"],["IN RETURN","returned"],["DELIVERED","delivered"]])
    assert.equal(shipmentStatus({carrier:"Geniki",status}).tone,tone,status);
  assert.equal(shipmentStatus({carrier:"ACS",statusCode:"IN_TRANSIT",checkpointStatus:"CARRIER_PICKED_UP"}).tone,"picked-up");
  assert.equal(shipmentStatus({status:"Closed"}).tone,"waiting");
  assert.notEqual(shipmentStatus({status:"Not delivered"}).tone,"delivered");
  assert.equal(shipmentStatus({status:"ACS label generated. Pickup: 2026-11-19"}).tone,"waiting");
});

test("needs-attention groups actual problems and returns, excluding cancelled and completed shipments",()=>{
  for(const status of ["DELIVERY_DELAYED","DELIVERY_ATTEMPTED","ACS_REVIEW_REQUIRED","IN RETURN","RETURN TO SENDER"])
    assert.equal(matchesTrackingStatus({status},"attention"),true,status);
  for(const status of ["DELIVERED","IN TRANSIT","Cancelled","Superseded"])
    assert.equal(matchesTrackingStatus({status},"attention"),false,status);
  assert.equal(matchesTrackingStatus({status:"RETURN TO SENDER"},"problem"),false);
  assert.equal(matchesTrackingStatus({status:"RETURN TO SENDER"},"returned"),true);
});

test("picked-up and transit filters use the same ACS checkpoint interpretation as the badge",()=>{
  const row={carrier:"ACS",statusCode:"IN_TRANSIT",checkpointStatus:"CARRIER_PICKED_UP"};
  assert.equal(matchesTrackingStatus(row,"picked-up"),true);
  assert.equal(matchesTrackingStatus(row,"transit"),false);
  assert.ok(trackingStatusWhere("picked-up","acs").OR.some(x=>x.lastShopifyEventStatus==="CARRIER_PICKED_UP"));
  assert.ok(trackingStatusWhere("problem","acs").OR[0].status.in.includes("DELIVERY_DELAYED"));
  assert.ok(trackingStatusWhere("delivered","geniki").OR[0].status.in.includes("DELIVERED"));
  assert.deepEqual(trackingStatusWhere("invalid","acs"),{});
});

test("tracking status shortcuts follow the preparation-to-delivery workflow",()=>{
  assert.deepEqual(trackingStatusChips.map(([key])=>key),["","waiting","picked-up","transit","delivered","problem","returned"]);
});

test("tracking numbers open the matching courier rather than a label-management page",()=>{
  assert.equal(courierTrackingUrl("Geniki","1234567890"),"https://www.taxydromiki.com/en/track/1234567890");
  assert.equal(courierTrackingUrl("ACS","1234567890"),"https://webapp.acscourier.net/track-shipment/1234567890");
  assert.equal(courierTrackingUrl("Geniki","123/456"),"https://www.taxydromiki.com/en/track/123%2F456");
  assert.equal(courierTrackingUrl("unknown","123"),null);
  assert.equal(courierTrackingUrl("ACS",null),null);
});
