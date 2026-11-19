// Polling time is not a shipment's creation time. Unknown dates stay at the end.
export function acsShipmentDate(snapshot){
  return snapshot.fulfillmentCreatedAt||snapshot.orderCreatedAt||snapshot.lastEventAt||null;
}
export function newestShipmentsFirst(a,b){
  const time=row=>{const value=row.createdAt?new Date(row.createdAt).getTime():0;return Number.isFinite(value)?value:0;};
  return time(b)-time(a);
}
