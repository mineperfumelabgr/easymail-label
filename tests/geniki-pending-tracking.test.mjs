import test from "node:test";
import assert from "node:assert/strict";
import {readGenikiTracking,genikiJobFromLookup} from "../app/services/geniki.server.js";

const row={voucher:"123",reference:"our-reference",status:"Ready for pickup"};
const notRegistered=()=>Object.assign(new Error("Geniki tracking result 9"),{genikiCode:"9"});
const job={Count:"0",Jobs:{VoucherJob:{Id:"12",OrderId:row.reference,Voucher:{VoucherNo:"123"},IsClosed:"false",IsCanceled:"false"}}};
test("tracking code 9 is pending only when the exact voucher exists on our open Geniki job",async()=>{
  let lookups=0;
  const api={tracking:async()=>{throw notRegistered();},lookup:async(key,reference)=>{lookups++;assert.equal(reference,row.reference);return job;}};
  assert.deepEqual(await readGenikiTracking(api,"test-key",row),{Status:"Ready for pickup",AwaitingRegistration:true});assert.equal(lookups,1);
});
test("missing, closed, cancelled and mismatched jobs remain real tracking errors",async()=>{
  for(const found of [null,{Count:"0"},{...job,Jobs:{VoucherJob:{...job.Jobs.VoucherJob,IsClosed:"true"}}},{...job,Jobs:{VoucherJob:{...job.Jobs.VoucherJob,IsCanceled:"true"}}},{...job,Jobs:{VoucherJob:{...job.Jobs.VoucherJob,Voucher:{VoucherNo:"other"}}}}]){
    await assert.rejects(readGenikiTracking({tracking:async()=>{throw notRegistered();},lookup:async()=>found},"test-key",row),/result 9/);
  }
});
test("other errors and previously moving shipments cannot be treated as newly issued labels",async()=>{
  const api={tracking:async()=>{throw Object.assign(new Error("Not authorized"),{genikiCode:"10"});},lookup:async()=>{throw new Error("Must not look up");}};
  await assert.rejects(readGenikiTracking(api,"test-key",row),/Not authorized/);
  await assert.rejects(readGenikiTracking({...api,tracking:async()=>{throw notRegistered();}},"test-key",{...row,status:"IN TRANSIT"}),/result 9/);
});
test("valid carrier tracking is returned without a job lookup",async()=>{
  const result={Status:"IN TRANSIT"};
  assert.equal(await readGenikiTracking({tracking:async()=>result,lookup:async()=>{throw new Error("Unexpected lookup");}},"test-key",row),result);
});
test("job lookup uses actual unique jobs and exact references instead of an incorrect Count field",()=>{
  assert.equal(genikiJobFromLookup(job,row.reference,row.voucher),job.Jobs.VoucherJob);
  assert.equal(genikiJobFromLookup(job,"another-reference",row.voucher),null);
  assert.equal(genikiJobFromLookup({...job,Count:"1",Jobs:{}},row.reference),null);
  assert.equal(genikiJobFromLookup({...job,Jobs:{VoucherJob:[job.Jobs.VoucherJob,job.Jobs.VoucherJob]}},row.reference),null);
});
