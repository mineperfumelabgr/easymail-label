export const TRACKING_RETENTION_MONTHS = 12;

export function trackingRetentionCutoff(now=new Date()) {
  const target=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-TRACKING_RETENTION_MONTHS,1));
  const year=target.getUTCFullYear(), month=target.getUTCMonth();
  const day=Math.min(now.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate());
  return new Date(Date.UTC(year,month,day,now.getUTCHours(),now.getUTCMinutes(),now.getUTCSeconds(),now.getUTCMilliseconds()));
}

// Never infer completion from label/order creation. Invalid or missing carrier
// dates use the observation time, so uncertain history is retained longer.
export function confirmedCompletionDate(value, observedAt=new Date()) {
  const date=value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) && date.getUTCFullYear()>=2000 && date<=observedAt
    ? date : new Date(observedAt);
}

export function acsRetentionWhere(shop,cutoff) {
  return {shop,trackingDetailsPurgedAt:null,completedAt:{lt:cutoff},error:null,
    OR:[{status:"DELIVERED",lastShopifyEventStatus:"DELIVERED"},{status:"RETURNED",lastShopifyEventStatus:"FAILURE"}]};
}

export function genikiRetentionWhere(shop,cutoff) {
  return {shop,carrier:"Geniki",environment:"live",trackingDetailsPurgedAt:null,completedAt:{lt:cutoff},
    status:{in:["DELIVERED","RETURN TO SENDER"]},genikiTerminalSynced:true,returnPending:false,returnSerial:null};
}

export function compactedContactFields() {
  return {recipientName:null,customerName:null,customerEmail:null,recipientPhone:null,addressPreview:null};
}
