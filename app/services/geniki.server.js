import { XMLBuilder, XMLParser } from "fast-xml-parser";

const endpoint = "https://testvoucher.taxydromiki.gr/JobServicesV2.asmx";
const namespace = "http://voucher.taxydromiki.gr/JobServicesV2.asmx";
const builder = new XMLBuilder({ ignoreAttributes: false });
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });

export function isCourierTestShop(shop) {
  return shop === "mine-perfume-lab-gr-dev.myshopify.com" ||
    process.env.SHOPIFY_API_KEY === "dd2b3ac472268547c2880beb7b420474";
}

function client(endpoint, prefix) {
  async function call(method, fields) {
    const body = builder.build({
      "soap:Envelope": {
        "@_xmlns:soap": "http://schemas.xmlsoap.org/soap/envelope/",
        "soap:Body": { [method]: { "@_xmlns": namespace, ...fields } },
      },
    });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: '"' + namespace + "/" + method + '"',
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok)
      throw new Error("Geniki " + method + " HTTP " + response.status);
    if (method === "GetVouchersPdf" || method === "GetReturnRequestPdf") {
      const pdf = Buffer.from(await response.arrayBuffer());
      if (pdf.subarray(0, 5).toString() !== "%PDF-")
        throw new Error("Geniki did not return a PDF");
      return pdf;
    }
    const envelope = parser.parse(await response.text());
    const result =
      envelope.Envelope?.Body?.[method + "Response"]?.[method + "Result"];
    const code = typeof result === "object" ? result?.Result : result;
    if (code !== "0") {
      const error = new Error("Geniki " + method + " result " + (code ?? "missing"));
      error.genikiCode = code;
      throw error;
    }
    return result;
  }

  async function authenticateGeniki(env = process.env) {
    const [GENIKI_TEST_USERNAME, GENIKI_TEST_PASSWORD, GENIKI_TEST_APP_KEY] = [
      "USERNAME",
      "PASSWORD",
      "APP_KEY",
    ].map((key) => env[prefix + key]);
    if (
      !GENIKI_TEST_USERNAME ||
      !GENIKI_TEST_PASSWORD ||
      !GENIKI_TEST_APP_KEY
    ) {
      throw new Error(prefix === "GENIKI_TEST_" ? "Geniki sandbox credentials are missing (GENIKI_TEST_USERNAME, GENIKI_TEST_PASSWORD, GENIKI_TEST_APP_KEY)." : "Geniki production credentials are missing.");
    }
    const result = await call("Authenticate", {
      sUsrName: GENIKI_TEST_USERNAME,
      sUsrPwd: GENIKI_TEST_PASSWORD,
      applicationKey: GENIKI_TEST_APP_KEY,
    });
    if (!result.Key) throw new Error("Geniki authentication key missing");
    return result.Key;
  }

  return {
    authenticate: authenticateGeniki,
    createOrderReturn: (key, voucher, days) => call("CreateVoucherReturnRequest", {
      sAuthKey:key, sVoucherNumber:voucher, nDaysValid:days, sRecipientId:"", bPayedBySender:false,
    }),
    findOrderReturn: (key, voucher) => call("GetReturnRequestOfVoucher", {sAuthKey:key,sVoucherNumber:voucher}),
    returnPdf: (key, serial) => call("GetReturnRequestPdf",{authKey:key,returnSerial:serial}),
    tracking: (key, voucher) =>
      call("TrackDeliveryStatus", {
        authKey: key,
        voucherNo: voucher,
        language: "en",
      }),
    create: (key, record) =>
      call("CreateJob", { sAuthKey: key, oVoucher: record, eType: "Voucher" }),
    lookup: (key, orderId) =>
      call("GetJobsFromOrderId", { sAuthKey: key, sOrderId: orderId }),
    pdf: (key, voucher) =>
      call("GetVouchersPdf", {
        authKey: key,
        voucherNumbers: { string: voucher },
        format: "Sticker",
        extraInfoFormat: "None",
      }),
    cancel: (key, jobId) =>
      call("CancelJob", { sAuthKey: key, nJobId: jobId, bCancel: true }),
    closeToday: (key) => call("ClosePendingJobs", { sAuthKey: key }),
    closeBetween: (key, from, to) =>
      call("ClosePendingJobsByDate", { sAuthKey: key, dFr: from, dTo: to }),
  };
}
export const genikiSandbox = client(endpoint, "GENIKI_TEST_");
export const authenticateGeniki = genikiSandbox.authenticate;
export const genikiLive = client(
  "https://voucher.taxydromiki.gr/JobServicesV2.asmx",
  "GENIKI_LIVE_",
);

export function genikiJobFromLookup(result,reference,voucher=null){
  // Production can report Count=0 while returning one actual VoucherJob.
  // Trust only one concrete job matching our reference (and voucher if known).
  const jobs=[result?.Jobs?.VoucherJob].flat().filter(Boolean);
  const job=jobs.length===1?jobs[0]:null;
  return job?.Id&&job.OrderId===reference&&job.IsCanceled==="false"&&(!voucher||job.Voucher?.VoucherNo===voucher)?job:null;
}

export async function readGenikiTracking(api,key,row) {
  try{return await api.tracking(key,row.voucher);}
  catch(error){
    if(error.genikiCode!=="9"||!row.reference||!["Ready for pickup","Label issued"].includes(row.status))throw error;
    // A newly issued, unfinalized job can exist before the tracking register.
    // Confirm the exact voucher on our own open job; never mask an unknown,
    // closed, cancelled, or mismatched job as a successful tracking response.
    const found=await api.lookup(key,row.reference).catch(()=>null),job=genikiJobFromLookup(found,row.reference,row.voucher);
    if(!job||job.IsClosed!=="false")throw error;
    return {Status:"Ready for pickup",AwaitingRegistration:true};
  }
}

export async function syncGenikiTracking(db, shop, applyTag) {
  const rows = await db.courierShipment.findMany({
    where: { shop, carrier: "Geniki", environment: "live", genikiTerminalSynced:false, voucher: {not:null},
      status: {notIn:["Cancelled","Superseded","Creating","Label issued","Submitting fulfillment","Label issued · tracking pending"]} },
    orderBy: [{ checkedAt: {sort:"asc", nulls:"first"} }, {createdAt:"asc"}], take: 40,
  });
  if (!rows.length) return {checked:0,errors:0};
  const key = await genikiLive.authenticate();
  let errors=0,pending=0;
  for (const row of rows) {
    try {
      const result=await readGenikiTracking(genikiLive,key,row);
      if(result.AwaitingRegistration)pending++;
      if(result.Status)await applyTag(row,result);
      await db.courierShipment.updateMany({where:{id:row.id,status:row.status},data:{status:result.Status||row.status,checkedAt:new Date()}});
    } catch {
      errors++;
      await db.courierShipment.update({where:{id:row.id},data:{checkedAt:new Date()}});
    }
  }
  return {checked:rows.length,errors,pending};
}

export function genikiParcelNumbers(master, records, expectedPieces) {
  const numbers = [...new Set([master, ...[records].flat().map(record => record?.VoucherNo)].filter(Boolean))];
  if (numbers.length < (expectedPieces || 1)) throw new Error("Geniki has not returned all parcel numbers. Retry to retrieve the existing shipment.");
  return numbers;
}
