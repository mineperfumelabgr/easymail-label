import test from 'node:test';
import assert from 'node:assert/strict';
import {acsShipmentDate,newestShipmentsFirst} from '../app/services/shipment-date.js';
test('Refreshing historical ACS tracking cannot push a new Geniki shipment down the list',()=>{
 const geniki={carrier:'Geniki',createdAt:'2026-11-19T13:08:02Z'};
 const acs={fulfillmentCreatedAt:'2026-11-01T10:00:00Z',orderCreatedAt:'2026-10-30T10:00:00Z',lastCheckedAt:'2026-11-19T15:02:00Z'};
 const rows=[{carrier:'ACS',createdAt:acsShipmentDate(acs)},geniki];
 rows.sort(newestShipmentsFirst);assert.equal(rows[0].carrier,'Geniki');
 acs.lastCheckedAt='2026-11-20T15:02:00Z';assert.equal(acsShipmentDate(acs),'2026-11-01T10:00:00Z');
});
test('Historical snapshots use order/event dates when necessary and unknown dates sort last',()=>{
 assert.equal(acsShipmentDate({orderCreatedAt:'2026-10-01',lastEventAt:'2026-10-10'}),'2026-10-01');
 assert.equal(acsShipmentDate({lastEventAt:'2026-10-10'}),'2026-10-10');
 assert.equal(acsShipmentDate({lastCheckedAt:'2026-11-19'}),null);
 const rows=[{createdAt:null},{createdAt:'invalid'},{createdAt:new Date('2026-11-19')},{createdAt:'2026-11-18'}];rows.sort(newestShipmentsFirst);assert.equal(rows[0].createdAt.toISOString().slice(0,10),'2026-11-19');assert.equal(rows[1].createdAt,'2026-11-18');
});
