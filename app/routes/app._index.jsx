import {dailyAcsLabels} from "../services/acs-daily.server";
import {cancelAcsLabel} from "../services/acs-cancellation.server";
import {runAcsTrackingSync} from "../services/acs-tracking-sync.server";
import {printAcsPickupList,getAcsPickupLists, extractPickupLists, issueAcsPickupList, extractIssuePickupListResult, makeAcsPickupListPdfUrl} from "../services/acs.server";
import { orderCod } from "../services/order-cod";
import {DailyHandover} from "../components/DailyHandover";
import {packingPdf, renderPdf} from "../services/packing-slips.server";
import {PrintDocuments} from "../components/PrintDocuments";
import { useState } from "react";
import {
  Form,
  Link,
  useLoaderData,
  useActionData,
  useNavigation,
  useSearchParams,
} from "react-router";
import { syncGenikiFulfillment } from "../services/geniki-operations.server";
import { PDFDocument } from "pdf-lib";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { createOrReuseAcsLabel, adminGraphql, parseCodAmountOverride, parsePickupDate } from "../services/acs-create-label.server";
import {
  defaults,
  issue,
  rulesFor,
} from "../services/courier-workspace.server";
import { genikiLive, genikiSandbox, isCourierTestShop } from "../services/geniki.server";
import {
  extractPdfBytesFromAcsResponse,
  printAcsVoucher,
} from "../services/acs.server";
import "../styles/courier.css";

const countries = { GR: "Greece", CY: "Cyprus", BG: "Bulgaria" };
const views = {
  orders: "Prepare orders",
  daily: "Daily labels",
  tracking: "Tracking",
  rules: "Courier rules",
};
const athensDay = (date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Athens",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
const activeLabel = row => Boolean(row.voucher) && !["Cancelled","Superseded"].includes(row.status);
const genikiFor = (row) =>
  row.environment === "test" ? genikiSandbox : genikiLive;

async function legacyDaily(admin,shop,date){
 const labels=await dailyAcsLabels(admin,date);
 const manual=await db.acsManualShipment.findMany({where:{shop,pickupDate:date}});
 return [...labels.map(r=>({id:"legacy:"+r.orderId+":"+r.voucherNumber,orderId:r.orderId,orderName:r.orderName,carrier:"ACS",voucher:r.voucherNumber,pieces:r.pieces,labels:r.shipmentNumbers,recipientName:r.customerName,addressPreview:r.addressPreview,country:r.country,status:"Issued",createdAt:r.createdAt})),
 ...manual.map(r=>({id:"manual:"+r.id,manualId:r.id,orderName:r.reference||"Manual shipment",carrier:"ACS",voucher:r.voucherNo,labels:JSON.parse(r.shipmentNumbers),recipientName:r.recipientName,addressPreview:[r.address,r.zip,r.city].filter(Boolean).join(", "),country:r.countryCode,status:"Issued",createdAt:r.createdAt}))];
}
async function addAddresses(admin, rows){
 const ids=[...new Set(rows.filter(r=>!r.recipientName||!r.addressPreview).map(r=>r.sourceOrderId||r.orderId).filter(id=>id?.startsWith("gid://shopify/Order/")))];
 for(let i=0;i<ids.length;i+=100){
 const {data}=await adminGraphql(admin,`query($ids:[ID!]!){nodes(ids:$ids){... on Order{id shippingAddress{name address1 address2 zip city countryCodeV2}}}}`,{ids:ids.slice(i,i+100)});
 const byId=new Map(data.nodes.filter(Boolean).map(o=>[o.id,o.shippingAddress]));
 for(const r of rows){const a=byId.get(r.sourceOrderId||r.orderId);if(a){r.recipientName ||= a.name;r.addressPreview ||= [a.address1,a.address2,a.zip,a.city].filter(Boolean).join(", ");r.country ||= a.countryCodeV2;}}
 }
}

export async function loader({ request }) {
  const {
    admin,
    session: { shop },
  } = await authenticate.admin(request);
  const p = new URL(request.url).searchParams;
  const view = Object.hasOwn(views, p.get("view")) ? p.get("view") : "orders";
  const rules = await rulesFor(shop);
  const country = p.get("country") || "",
    carrier = p.get("carrier") || "",
    date = p.get("date") || athensDay(new Date());
  let orders = [],
    rows = [];
  const employees = view === "orders" ? await db.employee.findMany({where:{shop},select:{id:true,name:true},orderBy:{name:"asc"}}) : [];
  let dailyTotals={ACS:0,Geniki:0};
  let pickupLists=[],pickupWarning="";
  const sandbox=isCourierTestShop(shop);
  let next = null;
  if (view === "orders") {
    const scopes = {all:null,unfulfilled:"fulfillment_status:unfulfilled",fulfilled:"fulfillment_status:fulfilled",on_hold:"fulfillment_status:on_hold"};
    const scope=Object.hasOwn(scopes,p.get("scope"))?p.get("scope"):"unfulfilled";
    const limit=Number(p.get("limit"));
    let response;
    try {
      response = await adminGraphql(
      admin,
      `query($after:String,$filter:String,$limit:Int!){orders(first:$limit,after:$after,sortKey:CREATED_AT,reverse:true,query:$filter){pageInfo{endCursor hasNextPage} nodes{id name acsVoucher:metafield(namespace:"acs",key:"voucher_number"){value} acsPieces:metafield(namespace:"acs",key:"pieces"){value} acsPickup:metafield(namespace:"acs",key:"pickup_date"){value} displayFulfillmentStatus test tags paymentGatewayNames totalOutstandingSet{shopMoney{amount currencyCode}} shippingAddress{name countryCodeV2} cancelledAt}}}`,
      { after: p.get("after"), filter:scopes[scope], limit:[50,100,150,200].includes(limit)?limit:50 },
    );
    } catch (error) {
      if (!/not approved to access the Order object|protected customer data/i.test(error.message)) throw error;
      return { view, rules, orders, rows, country, carrier, date, employees, next,
        accessNotice: "Shopify has restricted order access. In the Dev Dashboard, open this app’s Settings → Access requests → Protected customer data. Enable access, save, and reload this page." };
    }
    const { data } = response;
    orders = data.orders.nodes.filter(
      (o) => [o.name,o.shippingAddress?.name].some(value=>String(value||"").toLocaleLowerCase().includes((p.get("q")||"").trim().toLocaleLowerCase())),
    );
    const orderIds=orders.map(o=>o.id);
    const existing=await db.courierShipment.findMany({where:{shop,OR:[{orderId:{in:orderIds}},{sourceOrderId:{in:orderIds}}],voucher:{not:null},status:{notIn:["Cancelled","Superseded"]}},orderBy:{createdAt:"desc"},select:{id:true,orderId:true,sourceOrderId:true,carrier:true,weight:true,pieces:true,preparedBy:true,codAmount:true,voucher:true}});
    for(const order of orders){
      order.shipment=existing.find(row=>(row.sourceOrderId||row.orderId)===order.id && (row.carrier!=="ACS" || !order.acsVoucher?.value || row.voucher===order.acsVoucher.value));
      order.label=order.shipment?.carrier==="Geniki"?order.shipment:null;
      order.environment=(order.test || isCourierTestShop(shop)) ? "test" : "live";
    }
    if (data.orders.pageInfo.hasNextPage) next = data.orders.pageInfo.endCursor;
  }
  if (view === "daily" || view === "tracking") {
    const where = {
      shop,
      ...(country && view!=="daily" ? { country } : {}),
      ...(carrier ? { carrier } : {}),
    };
    if (view === "daily") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new Response("Invalid date", { status: 400 });
      const noon = new Date(date + "T12:00:00Z").getTime();
      where.createdAt = {
        gte: new Date(noon - 36 * 3600000),
        lt: new Date(noon + 36 * 3600000),
      };
    }
    rows = await db.courierShipment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      ...(view === "tracking" ? { take: 250 } : {}),
    });
    if (view === "daily")
      rows = rows.filter((r) => athensDay(r.createdAt) === date);
    if (view === "tracking" && carrier !== "Geniki") {
      const snapshots = await db.acsTrackingSnapshot.findMany({
        where: { shop },
        orderBy: { lastCheckedAt: "desc" },
        take: 250,
      });
      const byVoucher = new Map(
        rows.filter((r) => r.carrier === "ACS").map((r) => [r.voucher, r]),
      );
      for (const s of snapshots) {
        const existing = byVoucher.get(s.voucherNo);
        if (existing) {
          if(existing.status!=="Cancelled")existing.status = s.statusLabel;
          continue;
        }
        const dest = "";
        rows.push({
            id: "snapshot:"+s.id,
            orderId:s.orderId,recipientName:s.recipientName,
            orderName: s.orderName,
            country: dest,
            carrier: "ACS",
            voucher: s.voucherNo,
            status: s.statusLabel,
            createdAt: s.lastCheckedAt,
          });
      }
      rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    if(view==="daily" && carrier!=="Geniki"){
      const seen=new Set(rows.filter(r=>r.carrier==="ACS").map(r=>r.voucher));
      const legacy=await legacyDaily(admin,shop,date);
      rows.push(...legacy.filter(r=>!seen.has(r.voucher)));
      if(!sandbox)try{pickupLists=extractPickupLists(await getAcsPickupLists(date)).map(l=>({...l,url:makeAcsPickupListPdfUrl(l.pickupListNo,date)}))}catch(e){pickupWarning=e.message}
    }
    await addAddresses(admin,rows);
    if(view==="daily")for(const row of rows)if(activeLabel(row) && (row.carrier!=="Geniki" || row.environment===(sandbox?"test":"live")))dailyTotals[row.carrier]++;
    if(country) rows=rows.filter(r=>r.country===country);
  }
  return { view, rules, orders, rows, country, carrier, date, employees, next, pickupLists,pickupWarning,sandbox,dailyTotals };
}

async function labelErrorTag(admin,id,carrier,add){
  const mutation=add?"tagsAdd":"tagsRemove";
  const {data}=await adminGraphql(admin,`mutation($id:ID!,$tags:[String!]!){${mutation}(id:$id,tags:$tags){userErrors{message}}}`,{id,tags:[carrier.toUpperCase()+"_LABEL_ERROR"]});
  if(data[mutation].userErrors.length)throw new Error(data[mutation].userErrors.map(e=>e.message).join(", "));
}

export async function action({ request }) {
  const {
    admin,
    session: { shop },
  } = await authenticate.admin(request);
  const f = await request.formData(),
    intent = f.get("intent");
  if (intent === "addEmployee") {
    const name=String(f.get("name")||"").trim().replace(/\s+/g," ");
    if (!name || name.length>100) return {messages:["Enter an employee name (1–100 characters)."]};
    const normalizedName=name.toLocaleLowerCase();
    await db.employee.upsert({where:{shop_normalizedName:{shop,normalizedName}},create:{shop,name,normalizedName},update:{}});
    return {messages:["Employee available in Prepared by."]};
  }
  if (intent === "rules") {
    const entries = Object.keys(defaults).map((country) => ({
      shop,
      country,
      carrier: f.get(country),
    }));
    if (entries.some((r) => !["ACS", "Geniki"].includes(r.carrier)))
      throw new Response("Invalid rule", { status: 400 });
    await db.$transaction(
      entries.map((r) =>
        db.courierRule.upsert({
          where: { shop_country: { shop, country: r.country } },
          create: r,
          update: { carrier: r.carrier },
        }),
      ),
    );
    return { messages: ["Courier rules saved."] };
  }
  if(intent==="manifest" || intent==="printPickup"){
    const date=String(f.get("dailyDate")||"");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return {messages:["Invalid handover date."]};
    try{
      if(intent==="printPickup"){
        if(isCourierTestShop(shop))throw new Error("ACS pickup lists use the live account.");
        const number=String(f.get("number")||"");
        if(!/^\d+$/.test(number))throw new Error("Invalid pickup list number");
        const bytes=extractPdfBytesFromAcsResponse(await printAcsPickupList(number,date));
        if(!bytes?.length)throw new Error("ACS returned no pickup list PDF.");
        return {pdf:Buffer.from(bytes).toString("base64"),documentName:"ACS pickup list"};
      }
      const noon=Date.parse(date+"T12:00:00Z");
      const environment=isCourierTestShop(shop)?"test":"live";
      const found=await db.courierShipment.findMany({where:{shop,carrier:"Geniki",environment,createdAt:{gte:new Date(noon-36*3600000),lt:new Date(noon+36*3600000)}},orderBy:{createdAt:"asc"}});
      const rows=found.filter(r=>athensDay(r.createdAt)===date && activeLabel(r));
      if(!rows.length)throw new Error("No active Geniki shipments for this date.");
      await addAddresses(admin,rows);
      return {pdf:await renderPdf("scripts/geniki-handover.py",{date,environment,rows:rows.map(r=>[r.orderName,r.voucher,r.recipientName,r.country,String(r.pieces||r.labels?.length||1)])}),documentName:"Geniki handover list"};
    }catch(error){return {messages:[error.message]}}
  }
  if (intent === "close") {
    const date = f.get("closeDate"),
      environment = f.get("environment");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !["live", "test"].includes(environment) ||
      date > athensDay(new Date()) ||
      f.get("confirm") !== date
    )
      return {
        messages: ["Enter the displayed date to confirm finalization."],
      };
    if (isCourierTestShop(shop) && environment === "live") return {messages:["Choose Test for this store."]};
    const api = environment === "live" ? genikiLive : genikiSandbox;
    try {
      const key = await api.authenticate();
      await api.closeBetween(key, date + "T00:00:00", date + "T23:59:59.999");
      return {
        messages: [
          "Geniki confirmed finalization for " +
            date +
            " (" +
            environment +
            ").",
        ],
      };
    } catch (e) {
      return { messages: [e.message] };
    }
  }
  const rowCancel=typeof intent==="string" && intent.startsWith("cancel-row:");
  const ids = rowCancel?[intent.slice(11)]:[...new Set(f.getAll("selected"))];
  const dailyDate=String(f.get("dailyDate")||"");
  if(intent==="acsPickup"){
    if(isCourierTestShop(shop))return {messages:["ACS pickup lists are disabled in the test store."]};
    if(!/^\d{4}-\d{2}-\d{2}$/.test(dailyDate))return {messages:["Invalid pickup date."]};
    try{const r=extractIssuePickupListResult(await issueAcsPickupList(dailyDate));return {messages:[r.pickupListNo?"ACS pickup list "+r.pickupListNo:r.errorMessage||"ACS did not issue a list.",...(r.unprintedVouchers||[])]}}catch(e){return {messages:[e.message]}}
  }
  const messages=[];
  if(intent?.startsWith("replaceAcs:")){
    if(isCourierTestShop(shop))return {messages:["ACS live voucher issuance is disabled in this store."]};
    const id=intent.slice(11), previous=String(f.get("previous-"+id)||"");
    try {
      const employee=await db.employee.findFirst({where:{shop,id:String(f.get("employee")||"")}});
      if(!employee)throw new Error("Select the employee preparing this shipment.");
      const {data}=await adminGraphql(admin,`query($id:ID!){order(id:$id){test cancelledAt displayFulfillmentStatus}}`,{id});
      if(!previous || !data.order || data.order.test || data.order.cancelledAt || data.order.displayFulfillmentStatus!=="FULFILLED")throw new Error("Reload this order before replacement.");
      const pieces=Number(f.get("replacementPieces-"+id)),raw=String(f.get("replacementCod-"+id)||"").trim(), amount=Number(raw);
      if(!raw || !Number.isFinite(amount)||amount<0||!Number.isInteger(pieces)||pieces<1||pieces>5)throw new Error("Enter the parcel count and COD amount (0 for prepaid).");
      const r=await createOrReuseAcsLabel({admin,orderGid:id,forceNew:true,expectedVoucher:previous,pieces,codOverride:amount>0,codAmountOverride:amount,requestedPickupDate:parsePickupDate(f.get("replacementDate-"+id))});
      await db.courierShipment.updateMany({where:{shop,orderId:id,carrier:"ACS",voucher:previous},data:{voucher:r.voucherNumber,labels:r.shipmentNumbers,pieces,codAmount:amount,preparedBy:employee.name}});
      return {messages:[r.message],pdf:await labelsPdf([{carrier:"ACS",voucher:r.voucherNumber,orderName:String(f.get("name-"+id)||id)}])};
    }catch(error){return {messages:[error.message]}}
  }
  if (!ids.length || ids.length > 50)
    return { messages: ["Select 1–50 rows."] };

  const keyCache=new Map();
  async function labelsPdf(rows) {
    async function credentials(row){const api=genikiFor(row);if(!keyCache.has(api))keyCache.set(api,await api.authenticate());return keyCache.get(api)}
    const pdf = await PDFDocument.create();
    for (const row of rows) {
      try {
        if (!row.voucher || row.status === "Cancelled")
          throw new Error("No active voucher");
        for (const number of row.carrier==="ACS"?[row.voucher]:(row.labels || [row.voucher])) {
          const bytes =
            row.carrier === "Geniki"
              ? await genikiFor(row).pdf(await credentials(row), number)
              : extractPdfBytesFromAcsResponse(
                  await printAcsVoucher(number, {
                    printType: 1,
                    startPosition: 1,
                  }),
                );
          const src = await PDFDocument.load(bytes);
          for (const page of await pdf.copyPages(src, src.getPageIndices()))
            pdf.addPage(page);
        }
      } catch (e) {
        messages.push(row.orderName+" · PDF: "+e.message);
      }
    }

    return pdf.getPageCount()?Buffer.from(await pdf.save()).toString("base64"):null;
  }
  if(intent==="packing") {
    try{return {packing:await packingPdf(admin,ids),messages}}catch(error){return {messages:[error.message]}}
  }
  if (intent === "issue" || intent==="both") {
    const employee=await db.employee.findFirst({where:{shop,id:String(f.get("employee")||"")},select:{name:true}});
    if (!employee) return {messages:["Select the employee preparing these orders."]};
    let packing=null;
    if(intent==="both"){try{packing=await packingPdf(admin,ids)}catch(error){return {messages:["Packing slips: "+error.message]}}}
    const issued=[];
    const issuedRows=[];
    for (const id of ids) {
      try {
        const carrier=f.get("carrier-"+id);
        const pieces=Number(f.get("pieces-"+id));
        const weight=Number(f.get("weight-"+id)||1);
        if(!Number.isInteger(pieces)||pieces<1||pieces>5)throw new Error("Choose between 1 and 5 parcels.");
        if(!Number.isFinite(weight)||weight<=0)throw new Error("Enter a positive shipment weight.");
        const mode=f.get("cod-"+id);
        if (mode==="yes" && !String(f.get("amount-"+id)||"").trim()) throw new Error("Enter the COD amount to collect.");
        const r = await issue(admin, shop, id, carrier, weight, {
          employeeName:employee.name,pieces,pickupDate:carrier==="ACS"?parsePickupDate(f.get("pickup-"+id)):null,
          codOverride:mode==="yes"?true:mode==="no"?false:null,
          codAmount:mode==="yes"?parseCodAmountOverride(f.get("amount-"+id)):null,
        });
        issued.push(r.id);issuedRows.push(r);
        try{await labelErrorTag(admin,id,carrier,false)}catch(err){messages.push(r.orderName+" · Error tag cleanup: "+err.message)}
        if (r.preparedBy) {
          try {
            const {data}=await adminGraphql(admin,`mutation($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){userErrors{message}}}`,{id,tags:[r.preparedBy]});
            if(data.tagsAdd.userErrors.length)throw new Error(data.tagsAdd.userErrors[0].message);
          }catch(e){messages.push(r.orderName+" · Voucher issued; employee tag pending: "+e.message)}
        }
        messages.push(r.orderName + " · " + r.carrier + " · " + r.voucher);
      } catch (e) {
        const courier=f.get("carrier-"+id);const name=String(f.get("name-"+id)||id.split("/").pop());
        messages.push(name+" · "+(courier||"Courier")+" · "+e.message);
        if(["ACS","Geniki"].includes(courier))try{await labelErrorTag(admin,id,courier,true)}catch(err){messages.push(name+" · Could not apply error tag: "+err.message)}
      }
    }
    return { messages, issued, packing, pdf:await labelsPdf(issuedRows) };
  }
  const rows = await db.courierShipment.findMany({
    where: { shop, id: { in: ids } },
  });
  if(ids.some(id=>id.startsWith("legacy:")||id.startsWith("manual:")) && /^\d{4}-\d{2}-\d{2}$/.test(dailyDate)){
    const legacy=await legacyDaily(admin,shop,dailyDate);rows.push(...legacy.filter(r=>ids.includes(r.id)));
  }
  if(intent==="refresh" && ids.some(id=>id.startsWith("snapshot:"))){
    const snapshots=await db.acsTrackingSnapshot.findMany({where:{shop,id:{in:ids.filter(id=>id.startsWith("snapshot:")).map(id=>id.slice(9))}}});
    rows.push(...snapshots.map(r=>({carrier:"ACS",orderId:r.orderId,orderName:r.orderName,voucher:r.voucherNo})));
  }
  if (rows.length !== ids.length)
    return { messages: ["Selection expired. Reload the page."] };
  const keys = new Map();
  async function credentials(row) {
    const api = genikiFor(row);
    if (!keys.has(api)) keys.set(api, await api.authenticate());
    return keys.get(api);
  }
  if(intent==="print")return {pdf:await labelsPdf(rows),messages};
  for (const row of rows) {
    try {
      if(row.carrier==="ACS"){
        if(isCourierTestShop(shop))throw new Error("ACS operations are disabled in the test store.");
        if(rowCancel){
          if(row.status==="Cancelled")throw new Error("Voucher already cancelled");
          const message=await cancelAcsLabel(admin,row.voucher,row.orderId);
          if(row.manualId)await db.acsManualShipment.deleteMany({where:{shop,id:row.manualId}});
          else if(!row.id.startsWith("legacy:"))await db.courierShipment.updateMany({where:{shop,id:row.id},data:{status:"Cancelled"}});
          messages.push(row.orderName+" · "+message);
        }else if(intent==="refresh" && row.orderId){
          if(row.status==="Cancelled")throw new Error("Voucher cancelled");
          const sync=await runAcsTrackingSync(admin,shop,[row.orderId]);
          if(sync.errors.length)throw new Error(sync.errors.map(e=>e.message).join(", "));
          messages.push(row.orderName+(sync.checked?" updated":" · No active ACS tracking found"));
        }else throw new Error("No linked Shopify order.");
        continue;
      }
      if (row.carrier !== "Geniki" || !row.voucher)
        throw new Error("Select a Geniki voucher");
      const api = genikiFor(row),
        key = await credentials(row);
      if (rowCancel || intent === "cancel") {
        if (!rowCancel && f.get("confirmCancel") !== "on")
          throw new Error("Confirm cancellation first");
        await api.cancel(key, row.jobId);
        await db.courierShipment.update({
          where: { id: row.id },
          data: { status: "Cancelled" },
        });
      } else if (intent === "refresh") {
        if (["Cancelled","Superseded","Submitting fulfillment","Label issued"].includes(row.status))
          throw new Error("Shipment not ready for tracking");
        const r = await api.tracking(key, row.voucher);
        if(r.Status)await syncGenikiFulfillment(admin,row,r);
        await db.courierShipment.updateMany({
          where: { id: row.id, status:row.status, genikiTerminalSynced:false },
          data: { status: r.Status || row.status },
        });
      } else throw new Error("Unknown action");
      messages.push(row.orderName + " updated");
    } catch (e) {
      messages.push(row.orderName + " · " + e.message);
    }
  }
  return { messages };
}

function OrderCollection({order}) {
  const cod=orderCod(order);
  const [edited,setEdited]=useState(null);
  const enabled=edited?.enabled ?? cod.enabled;
  const amount=edited?.amount ?? (Number.isFinite(cod.amount)?cod.amount.toFixed(2):"");
  return <div className="order-collection">
    <label><input type="checkbox" checked={enabled} onChange={e=>setEdited({enabled:e.target.checked,amount})}/> COD</label>
    {cod.identified && <small>{cod.amount===0?"COD order · no balance due":"COD from order"}</small>}
    <input type="hidden" name={"cod-"+order.id} value={edited===null?"auto":enabled?"yes":"no"}/>
    {enabled && <label>Collect (€) <input type="number" min=".01" step=".01" name={"amount-"+order.id} value={amount}
      onChange={e=>setEdited({enabled:true,amount:e.target.value})}/></label>}
  </div>;
}

export default function Workspace() {
  const { view, rules, orders, rows, country, carrier, date, next, employees, accessNotice, pickupLists=[],pickupWarning,sandbox,dailyTotals } =
      useLoaderData(),
    result = useActionData(),
    busy = useNavigation().state !== "idle";
  const [p] = useSearchParams(),
    [choices, setChoices] = useState({});
  const href = (change) => {
    const params = new URLSearchParams(p);
    for (const [k, v] of Object.entries(change))
      v ? params.set(k, v) : params.delete(k);
    return "?" + params;
  };
  const select = (items, value, name) => (
    <select name={name} defaultValue={value}>
      {items.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
  return (
    <main className="courier">
      <header>
        <h1>Courier Label</h1>
        <nav>
          {Object.entries(views).map(([v, l]) => (
            <Link
              aria-current={view === v ? "page" : undefined}
              key={v}
              to={href({ view: v, after: null, country: null, carrier: null })}
            >
              {l}
            </Link>
          ))}
        </nav>
      </header>
      <section>
        {accessNotice && <p role="alert">{accessNotice}</p>}
        <h2>
          {view === "daily" && carrier === "Geniki"
            ? "Geniki Daily Labels"
            : views[view]}
        </h2>
        {["daily", "tracking"].includes(view) && (
          <Form method="get" key={p.toString()} className="controls">
            {[...p]
              .filter(
                ([k]) => !["country", "carrier", "date", "after"].includes(k),
              )
              .map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
            <label>
              Country{" "}
              {select(
                [["", "All countries"], ...Object.entries(countries)],
                country,
                "country",
              )}
            </label>
            <label>
              Courier{" "}
              {select(
                [
                  ["", "All couriers"],
                  ["ACS", "ACS"],
                  ["Geniki", "Geniki"],
                ],
                carrier,
                "carrier",
              )}
            </label>
            {view === "daily" && (
              <label>
                Date <input type="date" name="date" defaultValue={date} />
              </label>
            )}
            <button>Filter</button>
          </Form>
        )}
        {view==="orders" && <Form method="get" key={"order-filter"+p.toString()} className="controls">{[...p].filter(([k])=>!["scope","limit","q","after"].includes(k)).map(([k,v])=><input type="hidden" key={k} name={k} value={v}/>)}<input type="hidden" name="scope" value={p.get("scope")||"unfulfilled"}/><nav aria-label="Fulfillment status">{[["all","All"],["unfulfilled","Unfulfilled"],["fulfilled","Fulfilled"],["on_hold","On Hold"]].map(([value,label])=><Link key={value} aria-current={(p.get("scope")||"unfulfilled")===value?"page":undefined} to={href({scope:value,after:null})}>{label}</Link>)}</nav><label>Orders per page <select name="limit" defaultValue={p.get("limit")||"50"}>{[50,100,150,200].map(n=><option key={n}>{n}</option>)}</select></label><label>Search these orders <input name="q" defaultValue={p.get("q")||""} placeholder="Recipient or order number"/></label><button>Apply</button></Form>}
        {view==="daily" && <DailyHandover key={date+carrier} {...{date,carrier,sandbox,dailyTotals,pickupLists,pickupWarning}}/>}
        {view==="orders" && <details open={!employees.length || undefined}><summary>Add an employee</summary><Form method="post"><label>Employee name <input name="name" required maxLength={100}/></label><button name="intent" value="addEmployee">Add employee</button></Form></details>}
        <Form method="post" key={view + p.toString()}>
          <fieldset disabled={busy}><input type="hidden" name="dailyDate" value={date}/>
            {view === "rules" ? (
              <>
                {Object.entries(countries).map(([k, v]) => (
                  <label key={k}>
                    {v}{" "}
                    {select(
                      [
                        ["ACS", "ACS"],
                        ["Geniki", "Geniki"],
                      ],
                      rules[k],
                      k,
                    )}
                  </label>
                ))}
                <button name="intent" value="rules">
                  Save rules
                </button>
              </>
            ) : (
              <>
                <div className="controls">
                  {view === "orders" ? (
                    <>
                      <label>Prepared by <select name="employee" defaultValue=""><option value="">Select employee</option>{employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
                      <Link to={"/app/employees?"+p}>Manage employees</Link>
                      <button name="intent" value="both">Prepare packing slips + vouchers</button><button name="intent" value="packing" formNoValidate>Print packing slips only</button><button name="intent" value="issue">Prepare vouchers only</button>
                    </>
                  ) : view === "daily" ? (
                    <button name="intent" value="print">
                      Print selected labels
                    </button>
                  ) : (
                    <button name="intent" value="refresh">
                      Refresh selected shipments
                    </button>
                  )}
                </div>
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            aria-label="Select all visible"
                            onChange={(e) => {
                              for (const box of e.target.form.querySelectorAll(
                                'input[name="selected"]:enabled',
                              ))
                                box.checked = e.target.checked;
                            }}
                          />
                        </th>
                        <th>Order</th>
                        <th>Country</th>
                        <th>Courier</th>
                        {view==="orders"?<th>Shipment options</th>:<th>Prepared by · Parcels</th>}
                        {view !== "orders" && (
                          <>
                            <th>Voucher</th>
                            <th>Status</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {(view === "orders" ? orders : rows).map((r) => (
                        <tr key={r.id}>
                          <td>
                            <input
                              type="checkbox"
                              name="selected"
                              value={r.id}
                              aria-label={"Select " + (r.name || r.orderName)}
                              disabled={(view==="orders" && (r.displayFulfillmentStatus==="FULFILLED" || !r.shippingAddress || r.cancelledAt || r.displayFulfillmentStatus==="ON_HOLD")) || view==="tracking" && (r.status==="Cancelled" || (sandbox && r.carrier==="ACS"))}
                            />
                          </td>
                          <td>
                            {r.name || r.orderName}<input type="hidden" name={"name-"+r.id} value={r.name||r.orderName}/>
                            {view==="orders" && <div><small>{r.displayFulfillmentStatus?.toLowerCase().replaceAll("_"," ")}</small>{r.tags.map(tag=><span key={tag} style={{display:"inline-block",margin:"2px 3px",padding:"1px 6px",border:"1px solid #ccc",borderRadius:8}}>{tag}</span>)}</div>}
                            <div className="recipient">{view==="orders"?r.shippingAddress?.name:r.recipientName}</div>{view!=="orders" && <small>{r.addressPreview || "—"}</small>}
                            {r.label && <Link to={"/app/geniki-operations?"+new URLSearchParams({...Object.fromEntries(p),shipment:r.label.id})}> · Existing voucher {r.label.voucher}</Link>}
                            {(r.test || r.environment === "test") && " · Test"}
                          </td>
                          <td>
                            {countries[
                              r.country || r.shippingAddress?.countryCodeV2
                            ] ||
                              r.country ||
                              r.shippingAddress?.countryCodeV2 ||
                              "—"}
                          </td>
                          <td>
                            {view === "orders" && r.displayFulfillmentStatus==="FULFILLED" ? (r.shipment?.carrier || (r.acsVoucher?.value?"ACS":"—")) : view === "orders" ? (
                              <select
                                aria-label={"Courier for " + r.name}
                                name={"carrier-" + r.id}
                                value={
                                  choices[r.id] ||
                                  rules[r.shippingAddress?.countryCodeV2] ||
                                  ""
                                }
                                onChange={(e) =>
                                  setChoices({
                                    ...choices,
                                    [r.id]: e.target.value,
                                  })
                                }
                              >
                                <option value="">Choose courier</option>
                                <option>ACS</option>
                                <option>Geniki</option>
                              </select>
                            ) : (
                              r.carrier
                            )}
                          </td>
                          {view==="orders" && r.displayFulfillmentStatus==="FULFILLED"?<td>
                              <div>Voucher {r.shipment?.voucher || r.acsVoucher?.value || "—"}</div>
                              <div>Parcels {r.shipment?.pieces ?? r.acsPieces?.value ?? "—"} · COD {r.shipment?.codAmount==null?"—":r.shipment.codAmount.toFixed(2)+" €"}</div>
                              {r.shipment?.weight!=null && <div>Weight {r.shipment.weight} kg</div>}
                              {r.acsPickup?.value && <div>Pickup {r.acsPickup.value}</div>}
                              {r.shipment?.preparedBy && <div>Prepared by {r.shipment.preparedBy}</div>}
                              {r.label?<Link to={"/app/geniki-operations?"+new URLSearchParams({...Object.fromEntries(p),shipment:r.label.id})}>Issue a replacement voucher…</Link>:r.acsVoucher?.value && <details><summary>Replace ACS voucher…</summary>
                      <input type="hidden" name={"previous-"+r.id} value={r.acsVoucher.value}/>
                      <label>Parcels <input name={"replacementPieces-"+r.id} type="number" min="1" max="5" defaultValue={r.acsPieces?.value||1}/></label>
                      <label>Pickup <input type="date" name={"replacementDate-"+r.id} defaultValue={date}/></label>
                      <label>COD (€) <input name={"replacementCod-"+r.id} type="number" step=".01" min="0" defaultValue={r.shipment?.codAmount??""} placeholder="Enter 0 for prepaid"/></label>
                      <button name="intent" value={"replaceAcs:"+r.id} disabled={sandbox} formNoValidate onClick={e=>{if(!window.confirm("Create a new ACS voucher for "+r.name+"? The previous label may still be active."))e.preventDefault()}}>Issue replacement</button></details>}
                            </td>:view==="orders"?<td><div className="parcel-controls">
                            <label>Parcels <select name={"pieces-"+r.id} defaultValue="1">{[1,2,3,4,5].map(n=><option key={n}>{n}</option>)}</select></label>
                            {(choices[r.id]||rules[r.shippingAddress?.countryCodeV2])==="Geniki"?<label>Total kg <input type="number" name={"weight-"+r.id} step=".01" min=".01" defaultValue="1"/></label>:<details><summary>ACS options</summary>
                            <label>Pickup <input type="date" name={"pickup-"+r.id} defaultValue={date}/></label>
                            </details>}
                            {r.shippingAddress?.countryCodeV2==="GR" && <OrderCollection order={r}/>}
                            </div></td>:<td>{r.preparedBy||"—"} · {r.pieces||r.labels?.length||"—"}</td>}
                          {view !== "orders" && (
                            <>
                              <td>{r.carrier==="Geniki" && r.voucher?<Link to={"/app/geniki-operations?"+new URLSearchParams({...Object.fromEntries(p),shipment:r.id})}>{r.voucher}</Link>:r.voucher||"—"}</td>
                              <td><span className="shipment-state" data-tone={/cancel|fail|return|problem/i.test(r.status)?"warning":/deliver(ed)?$|closed|complete/i.test(r.status)?"success":"info"}>{r.status}</span>{view==="daily" && r.voucher && r.status!=="Cancelled" && <div><button type="submit" name="intent" value={"cancel-row:"+r.id} disabled={sandbox&&r.carrier==="ACS"} onClick={e=>{if(!window.confirm("Cancel "+r.carrier+" voucher "+r.voucher+" for "+r.orderName+"? Review its Shopify fulfillment separately."))e.preventDefault()}}>Cancel voucher</button></div>}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!(view === "orders" ? orders : rows).length && (
                  <p>No shipments match this view.</p>
                )}
                {view === "orders" && next && (
                  <Link to={href({ after: next })}>Next orders →</Link>
                )}
              </>
            )}
          </fieldset>
        </Form>
        {result?.messages && (
          <div role="status">
            {result.messages.map((m, i) => (
              <p key={i}>{m}</p>
            ))}
          </div>
        )}
        {result && <PrintDocuments result={result}/>}
      </section>
      <footer>
        <Link to={"/app/acs-operations?"+p}>ACS Operations</Link>
        <Link to={"/app/geniki-operations?"+p}>Geniki Operations</Link>
        <Link to={"/app/vouchers?" + p}>Other couriers · EasyMail</Link>
      </footer>
    </main>
  );
}
