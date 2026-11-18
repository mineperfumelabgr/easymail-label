import {dailyAcsLabels} from "../services/acs-daily.server";
import {cancelAcsLabel} from "../services/acs-cancellation.server";
import {runAcsTrackingSync} from "../services/acs-tracking-sync.server";
import {getAcsPickupLists, extractPickupLists, issueAcsPickupList, extractIssuePickupListResult, makeAcsPickupListPdfUrl} from "../services/acs.server";
import { orderCod } from "../services/order-cod";
import { useState } from "react";
import {
  Form,
  Link,
  useLoaderData,
  useActionData,
  useNavigation,
  useSearchParams,
} from "react-router";
import { applyGenikiTag } from "../services/geniki-operations.server";
import { PDFDocument } from "pdf-lib";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { adminGraphql, parseCodAmountOverride, parsePickupDate } from "../services/acs-create-label.server";
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
  let pickupLists=[],pickupWarning="";
  const sandbox=isCourierTestShop(shop);
  let next = null;
  if (view === "orders") {
    let response;
    try {
      response = await adminGraphql(
      admin,
      `query($after:String){orders(first:50,after:$after,sortKey:CREATED_AT,reverse:true,query:"status:open fulfillment_status:unfulfilled OR fulfillment_status:partial"){pageInfo{endCursor hasNextPage} nodes{id name test tags paymentGatewayNames totalOutstandingSet{shopMoney{amount currencyCode}} shippingAddress{name countryCodeV2} cancelledAt}}}`,
      { after: p.get("after") },
    );
    } catch (error) {
      if (!/not approved to access the Order object|protected customer data/i.test(error.message)) throw error;
      return { view, rules, orders, rows, country, carrier, date, employees, next,
        accessNotice: "Shopify has restricted order access. In the Dev Dashboard, open this app’s Settings → Access requests → Protected customer data. Enable access, save, and reload this page." };
    }
    const { data } = response;
    orders = data.orders.nodes.filter(
      (o) => o.shippingAddress && !o.cancelledAt,
    );
    const existing = await db.courierShipment.findMany({where:{shop,carrier:"Geniki",orderId:{in:orders.map(o=>o.id)},voucher:{not:null}},select:{id:true,orderId:true,voucher:true}});
    for(const order of orders){
      order.label=existing.find(row=>row.orderId===order.id);
      order.environment=(order.test || isCourierTestShop(shop)) ? "test" : "live";
    }
    if (data.orders.pageInfo.hasNextPage) next = data.orders.pageInfo.endCursor;
  }
  if (view === "daily" || view === "tracking") {
    const where = {
      shop,
      ...(country ? { country } : {}),
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
    if(country) rows=rows.filter(r=>r.country===country);
  }
  return { view, rules, orders, rows, country, carrier, date, employees, next, pickupLists,pickupWarning,sandbox };
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
  if (!ids.length || ids.length > 50)
    return { messages: ["Select 1–50 rows."] };
  const messages = [];
  if (intent === "issue") {
    const employee=await db.employee.findFirst({where:{shop,id:String(f.get("employee")||"")},select:{name:true}});
    if (!employee) return {messages:["Select the employee preparing these orders."]};
    const issued=[];
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
        issued.push(r.id);
        if (r.preparedBy) {
          try {
            const {data}=await adminGraphql(admin,`mutation($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){userErrors{message}}}`,{id,tags:[r.preparedBy]});
            if(data.tagsAdd.userErrors.length)throw new Error(data.tagsAdd.userErrors[0].message);
          }catch(e){messages.push(r.orderName+" · Voucher issued; employee tag pending: "+e.message)}
        }
        messages.push(r.orderName + " · " + r.carrier + " · " + r.voucher);
      } catch (e) {
        messages.push(id.split("/").pop() + " · " + e.message);
      }
    }
    return { messages, issued };
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
  if (intent === "print") {
    const pdf = await PDFDocument.create();
    for (const row of rows) {
      try {
        if (!row.voucher || row.status === "Cancelled")
          throw new Error("No active voucher");
        for (const number of row.labels || [row.voucher]) {
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
        return { messages: [row.orderName + " · " + e.message] };
      }
    }
    return {
      pdf: Buffer.from(await pdf.save()).toString("base64"),
      messages: ["Combined PDF ready."],
    };
  }
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
        if(r.Status)await applyGenikiTag(admin,row,r.Status);
        await db.courierShipment.update({
          where: { id: row.id },
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
  const { view, rules, orders, rows, country, carrier, date, next, employees, accessNotice, pickupLists=[],pickupWarning,sandbox } =
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
                      <label>Prepared by <select name="employee" required defaultValue=""><option value="">Select employee</option>{employees.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
                      <Link to={"/app/employees?"+p}>Manage employees</Link>
                      <button name="intent" value="issue">
                        Generate selected vouchers
                      </button>
                    </>
                  ) : view === "daily" ? (
                    <button name="intent" value="print">
                      Download selected as one PDF
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
                              disabled={view==="tracking" && (r.status==="Cancelled" || (sandbox && r.carrier==="ACS"))}
                            />
                          </td>
                          <td>
                            {r.name || r.orderName}
                            <div className="recipient">{view==="orders"?r.shippingAddress.name:r.recipientName}</div>{view!=="orders" && <small>{r.addressPreview || "—"}</small>}
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
                            {view === "orders" ? (
                              <select
                                aria-label={"Courier for " + r.name}
                                name={"carrier-" + r.id}
                                value={
                                  choices[r.id] ||
                                  rules[r.shippingAddress.countryCodeV2] ||
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
                          {view==="orders"?<td><div className="parcel-controls">
                            <label>Parcels <select name={"pieces-"+r.id} defaultValue="1">{[1,2,3,4,5].map(n=><option key={n}>{n}</option>)}</select></label>
                            {(choices[r.id]||rules[r.shippingAddress.countryCodeV2])==="Geniki"?<label>Total kg <input type="number" name={"weight-"+r.id} step=".01" min=".01" defaultValue="1"/></label>:<details><summary>ACS options</summary>
                            <label>Pickup <input type="date" name={"pickup-"+r.id} defaultValue={date}/></label>
                            </details>}
                            {r.shippingAddress.countryCodeV2==="GR" && <OrderCollection order={r}/>}
                            </div></td>:<td>{r.preparedBy||"—"} · {r.pieces||r.labels?.length||"—"}</td>}
                          {view !== "orders" && (
                            <>
                              <td>{r.carrier==="Geniki" && r.voucher?<Link to={"/app/geniki-operations?"+new URLSearchParams({...Object.fromEntries(p),shipment:r.id})}>{r.voucher}</Link>:r.voucher||"—"}</td>
                              <td>{r.status}{view==="daily" && r.voucher && r.status!=="Cancelled" && <div><button type="submit" name="intent" value={"cancel-row:"+r.id} disabled={sandbox&&r.carrier==="ACS"} onClick={e=>{if(!window.confirm("Cancel "+r.carrier+" voucher "+r.voucher+" for "+r.orderName+"? Review its Shopify fulfillment separately."))e.preventDefault()}}>Cancel voucher</button></div>}</td>
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
        {view==="daily" && carrier!=="Geniki" && <details><summary>ACS pickup lists</summary>
      {sandbox?<p>ACS pickup lists are disabled in the test store.</p>:<Form method="post"><input type="hidden" name="dailyDate" value={date}/><button name="intent" value="acsPickup" disabled={busy} onClick={e=>{if(!window.confirm("Issue the ACS pickup list for "+date+"?"))e.preventDefault()}}>Issue ACS pickup list</button></Form>}
      {pickupWarning&&<p>{pickupWarning}</p>}{pickupLists.map(l=><p key={l.pickupListNo}><a href={l.url} target="_blank" rel="noreferrer">Print ACS list {l.pickupListNo}</a> · {l.listVouchersCount} vouchers</p>)}</details>}
        {view === "daily" && carrier !== "ACS" && (
          <details>
            <summary>Geniki · Finalize daily handover</summary>
            <Form method="post">
              <input type="hidden" name="closeDate" value={date} />
              <p>
                Geniki closes every pending voucher in the account for {date},
                including vouchers created outside Courier Label.
              </p>
              <label>
                Environment{" "}
                {select(
                  [
                    ["test", "Test"],
                    ["live", "Live"],
                  ],
                  "test",
                  "environment",
                )}
              </label>
              <label>
                Confirm date{" "}
                <input name="confirm" placeholder={date} required />
              </label>
              <button name="intent" value="close" disabled={busy}>
                Finalize handover
              </button>
            </Form>
          </details>
        )}
        {result?.messages && (
          <div role="status">
            {result.messages.map((m, i) => (
              <p key={i}>{m}</p>
            ))}
          </div>
        )}
        {result?.issued?.length>0 && <Form method="post">{result.issued.map(id=><input key={id} type="hidden" name="selected" value={id}/>)}<button name="intent" value="print" disabled={busy}>Print generated labels in one PDF</button></Form>}
        {result?.pdf && (
          <a
            download="courier-labels.pdf"
            href={"data:application/pdf;base64," + result.pdf}
          >
            Save combined PDF
          </a>
        )}
      </section>
      <footer>
        <Link to={href({view:"daily",carrier:"ACS"})}>ACS Daily Labels</Link>
        <Link to={href({ view: "daily", carrier: "Geniki" })}>
          Geniki Daily Labels
        </Link>
        <Link to={"/app/vouchers?" + p}>Other couriers · EasyMail</Link>
      </footer>
    </main>
  );
}
