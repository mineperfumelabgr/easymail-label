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
import { adminGraphql } from "../services/acs-create-label.server";
import {
  defaults,
  issue,
  rulesFor,
} from "../services/courier-workspace.server";
import { genikiLive, genikiSandbox } from "../services/geniki.server";
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
  let next = null;
  if (view === "orders") {
    let response;
    try {
      response = await adminGraphql(
      admin,
      `query($after:String){orders(first:50,after:$after,sortKey:CREATED_AT,reverse:true,query:"status:open fulfillment_status:unfulfilled OR fulfillment_status:partial"){pageInfo{endCursor hasNextPage} nodes{id name test shippingAddress{countryCodeV2} cancelledAt}}}`,
      { after: p.get("after") },
    );
    } catch (error) {
      if (!/not approved to access the Order object|protected customer data/i.test(error.message)) throw error;
      return { view, rules, orders, rows, country, carrier, date, next,
        accessNotice: "Shopify has restricted order access. In the Dev Dashboard, open this app’s Settings → Access requests → Protected customer data. Enable access, save, and reload this page." };
    }
    const { data } = response;
    orders = data.orders.nodes.filter(
      (o) => o.shippingAddress && !o.cancelledAt,
    );
    const existing = await db.courierShipment.findMany({where:{shop,carrier:"Geniki",orderId:{in:orders.map(o=>o.id)},voucher:{not:null}},select:{id:true,orderId:true,voucher:true}});
    for(const order of orders)order.label=existing.find(row=>row.orderId===order.id);
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
      const ids = [...new Set(snapshots.map((r) => r.orderId).filter(Boolean))];
      const addressById = new Map();
      if (ids.length) {
        const { data } = await adminGraphql(
          admin,
          `query($ids:[ID!]!){nodes(ids:$ids){... on Order{id shippingAddress{countryCodeV2}}}}`,
          { ids },
        );
        for (const o of data.nodes.filter(Boolean))
          addressById.set(o.id, o.shippingAddress?.countryCodeV2);
      }
      const byVoucher = new Map(
        rows.filter((r) => r.carrier === "ACS").map((r) => [r.voucher, r]),
      );
      for (const s of snapshots) {
        const existing = byVoucher.get(s.voucherNo);
        if (existing) {
          existing.status = s.statusLabel;
          continue;
        }
        const dest = addressById.get(s.orderId) || "";
        if (!country || dest === country)
          rows.push({
            id: s.id,
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
  }
  return { view, rules, orders, rows, country, carrier, date, next };
}

export async function action({ request }) {
  const {
    admin,
    session: { shop },
  } = await authenticate.admin(request);
  const f = await request.formData(),
    intent = f.get("intent");
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
  const ids = [...new Set(f.getAll("selected"))];
  if (!ids.length || ids.length > 50)
    return { messages: ["Select 1–50 rows."] };
  const messages = [];
  if (intent === "issue") {
    const weight = Number(f.get("weight"));
    if (!Number.isFinite(weight) || weight <= 0)
      return { messages: ["Enter the packed weight in kg."] };
    for (const id of ids) {
      try {
        const r = await issue(admin, shop, id, f.get("carrier-" + id), weight);
        messages.push(r.orderName + " · " + r.carrier + " · " + r.voucher);
      } catch (e) {
        messages.push(id.split("/").pop() + " · " + e.message);
      }
    }
    return { messages };
  }
  const rows = await db.courierShipment.findMany({
    where: { shop, id: { in: ids } },
  });
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
      if (row.carrier !== "Geniki" || !row.voucher)
        throw new Error("Select a Geniki voucher");
      const api = genikiFor(row),
        key = await credentials(row);
      if (intent === "cancel") {
        if (f.get("confirmCancel") !== "on")
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

export default function Workspace() {
  const { view, rules, orders, rows, country, carrier, date, next, accessNotice } =
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
        <Form method="post" key={view + p.toString()}>
          <fieldset disabled={busy}>
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
                      <label>
                        Geniki weight per parcel (kg){" "}
                        <input
                          type="number"
                          step=".01"
                          min=".01"
                          name="weight"
                          defaultValue="1"
                        />
                      </label>
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
                      Refresh selected Geniki shipments
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
                              disabled={
                                view === "tracking" && r.carrier !== "Geniki"
                              }
                            />
                          </td>
                          <td>
                            {r.name || r.orderName}
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
                          {view !== "orders" && (
                            <>
                              <td>{r.carrier==="Geniki" && r.voucher?<Link to={"/app/geniki-operations?"+new URLSearchParams({...Object.fromEntries(p),shipment:r.id})}>{r.voucher}</Link>:r.voucher||"—"}</td>
                              <td>{r.status}</td>
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
                {view === "daily" && carrier === "Geniki" && (
                  <details>
                    <summary>Cancel selected vouchers</summary>
                    <label>
                      <input type="checkbox" name="confirmCancel" /> Cancel with
                      Geniki. Review the corresponding Shopify fulfillments
                      separately.
                    </label>
                    <button name="intent" value="cancel">
                      Cancel selected vouchers
                    </button>
                  </details>
                )}
                {view === "orders" && next && (
                  <Link to={href({ after: next })}>Next orders →</Link>
                )}
              </>
            )}
          </fieldset>
        </Form>
        {view === "daily" && carrier === "Geniki" && (
          <details>
            <summary>Finalize daily handover</summary>
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
        <Link to={"/app/acs-vouchers?" + p}>ACS daily operations</Link>
        <Link to={href({ view: "daily", carrier: "Geniki" })}>
          Geniki Daily Labels
        </Link>
        <Link to={"/app/vouchers?" + p}>Other couriers · EasyMail</Link>
      </footer>
    </main>
  );
}
