import { XMLBuilder, XMLParser } from "fast-xml-parser";

const endpoint = "https://testvoucher.taxydromiki.gr/JobServicesV2.asmx";
const namespace = "http://voucher.taxydromiki.gr/JobServicesV2.asmx";
const builder = new XMLBuilder({ ignoreAttributes: false });
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });

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
    if (method === "GetVouchersPdf") {
      const pdf = Buffer.from(await response.arrayBuffer());
      if (pdf.subarray(0, 5).toString() !== "%PDF-")
        throw new Error("Geniki did not return a PDF");
      return pdf;
    }
    const envelope = parser.parse(await response.text());
    const result =
      envelope.Envelope?.Body?.[method + "Response"]?.[method + "Result"];
    const code = typeof result === "object" ? result?.Result : result;
    if (code !== "0")
      throw new Error("Geniki " + method + " result " + (code ?? "missing"));
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
      throw new Error("Geniki test credentials are missing");
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

export async function syncGenikiTracking(db, shop) {
  const rows = await db.courierShipment.findMany({
    where: { shop, carrier: "Geniki", environment: "live", voucher: {not:null},
      status: {notIn:["Cancelled","DELIVERED","Creating","Label issued","Submitting fulfillment"]} },
    orderBy: [{ checkedAt: {sort:"asc", nulls:"first"} }, {createdAt:"asc"}], take: 40,
  });
  if (!rows.length) return {checked:0,errors:0};
  const key = await genikiLive.authenticate();
  let errors=0;
  for (const row of rows) {
    try {
      const result=await genikiLive.tracking(key,row.voucher);
      await db.courierShipment.updateMany({where:{id:row.id,status:row.status},data:{status:result.Status||row.status,checkedAt:new Date()}});
    } catch {
      errors++;
      await db.courierShipment.update({where:{id:row.id},data:{checkedAt:new Date()}});
    }
  }
  return {checked:rows.length,errors};
}
