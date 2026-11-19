import {Prisma} from "@prisma/client";
import {acsRetentionWhere,genikiRetentionWhere,trackingRetentionCutoff,compactedContactFields,TRACKING_RETENTION_MONTHS} from "./tracking-retention.js";

const BATCH_SIZE=200;
class RetainChangedShipment extends Error {}

// Runs after normal tracking sync. No voucher, order, fulfillment, return or
// replacement reference is deleted. Indexed, bounded batches are repeat-safe.
export async function compactOldTracking(db,shop,now=new Date()) {
  const cutoff=trackingRetentionCutoff(now), contacts=compactedContactFields();
  const protectedAcs=await db.courierShipment.findMany({where:{shop,carrier:"ACS",voucher:{not:null},
    OR:[{returnPending:true},{returnSerial:{not:null}},{status:{in:["Cancelled","Superseded"]}}]},select:{voucher:true}});
  const protectedVouchers=protectedAcs.map(row=>row.voucher).filter(Boolean);
  const acsWhere={...acsRetentionWhere(shop,cutoff),...(protectedVouchers.length?{voucherNo:{notIn:protectedVouchers}}:{})}, genikiWhere=genikiRetentionWhere(shop,cutoff);
  const acs=await db.acsTrackingSnapshot.findMany({where:acsWhere,orderBy:{completedAt:"asc"},take:BATCH_SIZE,
    select:{id:true,voucherNo:true,completedAt:true,status:true}});
  let acsCompacted=0,acsLabelRecordsCompacted=0;
  for (const row of acs) {
    const result=await db.$transaction(async tx=>{
      // Take the label write lock first. A simultaneous return request either
      // wins that lock and protects the details, or starts after compaction.
      const labels=await tx.courierShipment.updateMany({where:{shop,carrier:"ACS",voucher:row.voucherNo,trackingDetailsPurgedAt:null,
        returnPending:false,returnSerial:null,status:{notIn:["Cancelled","Superseded"]}},
        data:{...contacts,fulfillmentPlan:Prisma.DbNull,completedAt:row.completedAt,trackingDetailsPurgedAt:now}});
      const changed=await tx.courierShipment.findMany({where:{shop,carrier:"ACS",voucher:row.voucherNo,
        OR:[{returnPending:true},{returnSerial:{not:null}},{status:{in:["Cancelled","Superseded"]}}]},select:{id:true}});
      if(changed.length)throw new RetainChangedShipment();
      const snapshot=await tx.acsTrackingSnapshot.updateMany({where:{...acsWhere,id:row.id,status:row.status,completedAt:row.completedAt},
        data:{...contacts,reasonCode:null,lastCheckpoint:null,lastLocation:null,error:null,trackingDetailsPurgedAt:now}});
      if(!snapshot.count)throw new RetainChangedShipment();
      return {snapshots:snapshot.count,labels:labels.count};
    }).catch(error=>{if(error instanceof RetainChangedShipment)return {snapshots:0,labels:0};throw error;});
    acsCompacted+=result.snapshots;
    acsLabelRecordsCompacted+=result.labels;
  }
  const geniki=await db.courierShipment.findMany({where:genikiWhere,orderBy:{completedAt:"asc"},take:BATCH_SIZE,select:{id:true}});
  const result=geniki.length ? await db.courierShipment.updateMany({where:{...genikiWhere,id:{in:geniki.map(row=>row.id)}},
    data:{...contacts,fulfillmentPlan:Prisma.DbNull,trackingDetailsPurgedAt:now}}) : {count:0};
  return {months:TRACKING_RETENTION_MONTHS,cutoff:cutoff.toISOString(),acsCompacted,acsLabelRecordsCompacted,genikiCompacted:result.count};
}
