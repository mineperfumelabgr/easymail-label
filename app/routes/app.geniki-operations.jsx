import {PrintDocuments} from "../components/PrintDocuments";
import { randomUUID } from "node:crypto";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { issue } from "../services/courier-workspace.server";
import "../styles/courier.css";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  createGenikiParcel,
  replaceGeniki,
} from "../services/geniki-operations.server";
import { genikiLive, genikiSandbox, isCourierTestShop } from "../services/geniki.server";

const tagStates = ["IN TRANSIT", "DELIVERED", "IN RETURN"];
export async function loader({ request }) {
  const {
    session: { shop },
  } = await authenticate.admin(request);
  const id = new URL(request.url).searchParams.get("shipment");
  const row = id
    ? await db.courierShipment.findFirst({
        where: { shop, id, carrier: "Geniki" },
      })
    : null;
  const rules = await db.genikiTagRule.findMany({ where: { shop } });
  return {
    row,
    rules: Object.fromEntries(rules.map((r) => [r.status, r.tag])),
    token: randomUUID(),
  };
}
export async function action({ request }) {
  const {
    admin,
    session: { shop },
  } = await authenticate.admin(request);
  const f = await request.formData(),
    op = f.get("op");
  try {
    if (op === "tags") {
      const rules = tagStates.map((status) => ({
        shop,
        status,
        tag: String(f.get(status) || "").trim(),
      }));
      if (rules.some((r) => r.tag.length > 40 || r.tag.includes(",")))
        throw new Error("Use one tag per status, up to 40 characters.");
      await db.$transaction(
        rules.map((r) =>
          db.genikiTagRule.upsert({
            where: { shop_status: { shop, status: r.status } },
            create: r,
            update: { tag: r.tag },
          }),
        ),
      );
      return { message: "Order tag rules saved." };
    }
    if (op === "fulfill") {
      const row = await db.courierShipment.findFirstOrThrow({
        where: { id: String(f.get("id")), shop, carrier: "Geniki" },
      });
      if (!row.voucher || !row.orderId.startsWith("gid://shopify/Order/"))
        throw new Error("Select a Shopify order voucher.");
      const updated = await issue(admin, shop, row.orderId, "Geniki", 1);
      return {
        message:
          "Shopify fulfillment and tracking confirmed for " + updated.voucher,
      };
    }
    if (op === "order-return") {
      const row = await db.courierShipment.findFirstOrThrow({
        where: { id: String(f.get("id")), shop, carrier: "Geniki" },
      });
      if (
        !row.voucher ||
        !(row.sourceOrderId || row.orderId).startsWith(
          "gid://shopify/Order/",
        ) ||
        ["Cancelled", "Superseded"].includes(row.status)
      )
        throw new Error("Select an active Geniki order shipment.");
      const api = row.environment === "test" ? genikiSandbox : genikiLive;
      const key = await api.authenticate();
      let serial = row.returnSerial;
      if (!serial) {
        if (f.get("requested") !== "on")
          throw new Error("Confirm the customer's return request.");
        const days = Number(f.get("days"));
        if (!Number.isInteger(days) || days < 1 || days > 365)
          throw new Error("Choose a coupon validity between 1 and 365 days.");
        const claim = await db.courierShipment.updateMany({
          where: { id: row.id, shop, returnSerial: null, returnPending: false },
          data: { returnPending: true },
        });
        let response;
        try {
          response = claim.count
            ? await api.createOrderReturn(key, row.voucher, days)
            : await api.findOrderReturn(key, row.voucher);
        } catch (error) {
          if (
            claim.count &&
            error.genikiCode &&
            /^-?\d+$/.test(error.genikiCode)
          ) {
            await db.courierShipment.updateMany({
              where: { id: row.id, returnSerial: null },
              data: { returnPending: false },
            });
          }
          throw error;
        }
        serial = response.ReturnSerial;
        if (!serial)
          throw new Error(
            "Geniki has not confirmed the return coupon. Check again before issuing another.",
          );
        await db.courierShipment.update({
          where: { id: row.id },
          data: { returnSerial: serial, returnPending: false },
        });
      }
      const pdf = await api.returnPdf(key, serial);
      return {
        message: "Return coupon " + serial + " ready to print.",
        documentName:"Geniki return coupon",
        pdf: pdf.toString("base64"),
        number: "return-" + serial,
      };
    }
    if (op === "print") {
      const row = await db.courierShipment.findFirstOrThrow({
        where: { id: String(f.get("id")), shop, carrier: "Geniki" },
      });
      if (!row.voucher || row.status === "Cancelled")
        throw new Error("No printable voucher");
      const api = row.environment === "test" ? genikiSandbox : genikiLive;
      const pdf = await api.pdf(await api.authenticate(), row.labels || [row.voucher]);
      return {
        message: "Original label ready.",
        pdf: pdf.toString("base64"),
        number: row.voucher,
      };
    }
    const weight = Number(f.get("weight"));
    if (!Number.isFinite(weight) || weight <= 0)
      throw new Error("Enter a positive packed weight.");
    if (op === "replace" && f.get("confirm") === "on") {
      const row = await replaceGeniki(admin, shop, String(f.get("id")), weight);
      return { message: "Current tracking: " + row.voucher, id: row.id };
    }
    if (op !== "manual") throw new Error("Confirm the new voucher first.");
    const fields = Object.fromEntries(
      ["name", "address", "city", "zip", "country", "phone", "reference"].map(
        (k) => [k, String(f.get(k) || "").trim()],
      ),
    );
    if (
      Object.values(fields).some((v) => !v) ||
      !["GR", "CY", "BG"].includes(fields.country)
    )
      throw new Error("Complete the recipient details.");
    const cod = Number(f.get("cod"));
    if (
      !Number.isFinite(cod) ||
      cod < 0 ||
      (cod > 0 && fields.country !== "GR")
    )
      throw new Error("Cash on delivery is available for Greece only.");
    const token = f.get("token"),
      environment = f.get("environment");
    if (
      !/^[a-f0-9-]{36}$/.test(token) ||
      !["test", "live"].includes(environment)
    )
      throw new Error("Invalid shipment request.");
    if (isCourierTestShop(shop) && environment === "live") throw new Error("Choose Test for this store.");
    const row = await createGenikiParcel(shop, environment, "manual:" + token, {
      ...fields,
      weight,
      cod,
    });
    return { message: "Manual voucher " + row.voucher, id: row.id };
  } catch (e) {
    return { message: e.message };
  }
}
export default function Operations() {
  const { row, rules, token } = useLoaderData(),
    result = useActionData(),
    busy = useNavigation().state !== "idle";
  return (
    <main className="courier operations">
      <h1>Geniki operations</h1>
      {row && (
        <section>
          <h2>{row.orderName} · Existing label</h2>
          <p>
            Voucher <strong>{row.voucher}</strong> · {row.status}
          </p>
          <Form method="post">
            <input type="hidden" name="id" value={row.id} />
            <button disabled={busy} name="op" value="print">
              Reprint existing label
            </button>
          </Form>
          {row.voucher &&
            (row.sourceOrderId || row.orderId).startsWith(
              "gid://shopify/Order/",
            ) &&
            !["Cancelled", "Superseded"].includes(row.status) && (
              <details>
                <summary className="action-tile return-action">Customer return</summary>
                <Form method="post">
                  <input type="hidden" name="id" value={row.id} />
                  {row.returnSerial ? (
                    <p>Return coupon {row.returnSerial}</p>
                  ) : (
                    <>
                      <label>
                        Coupon validity (days){" "}
                        <input
                          type="number"
                          name="days"
                          min="1"
                          max="365"
                          defaultValue="30"
                          required
                        />
                      </label>
                      <label>
                        <input type="checkbox" name="requested" required />{" "}
                        Customer requested this return
                      </label>
                    </>
                  )}
                  <button disabled={busy} name="op" value="order-return">
                    {row.returnSerial
                      ? "Print return PDF"
                      : row.returnPending
                        ? "Retrieve return coupon"
                        : "Generate return PDF"}
                  </button>
                </Form>
              </details>
            )}
          {!row.fulfillmentId &&
            row.voucher &&
            row.orderId.startsWith("gid://shopify/Order/") && (
              <Form method="post">
                <input type="hidden" name="id" value={row.id} />
                <button disabled={busy} name="op" value="fulfill">
                  Sync fulfillment and tracking
                </button>
              </Form>
            )}
          {row.fulfillmentId && row.status !== "Superseded" && (
            <details>
              <summary className="action-tile replacement-action">Issue a replacement voucher</summary>
              <Form method="post">
                <input type="hidden" name="id" value={row.id} />
                <label>
                  Packed weight (kg){" "}
                  <input
                    name="weight"
                    type="number"
                    min=".01"
                    step=".01"
                    required
                  />
                </label>
                <p>
                  The previous voucher stays on file and remains active with
                  Geniki until cancelled separately. The new number replaces it
                  on the same Shopify fulfillment.
                </p>
                <label>
                  <input type="checkbox" name="confirm" required /> Issue a new
                  voucher
                </label>
                <button disabled={busy} name="op" value="replace">
                  Generate new label
                </button>
              </Form>
            </details>
          )}
        </section>
      )}
      {result && (
        <section role="status">
          {result.message}{" "}
          {result.pdf && <PrintDocuments result={result}/>}
          {result.id && (
            <a
              href={
                "?" +
                new URLSearchParams({
                  ...Object.fromEntries(
                    new URLSearchParams(
                      typeof window !== "undefined"
                        ? window.location.search
                        : "",
                    ),
                  ),
                  shipment: result.id,
                })
              }
            >
              Open voucher
            </a>
          )}
        </section>
      )}
      <section>
        <h2>Manual shipment</h2>
        <Form method="post">
          <input type="hidden" name="token" value={token} />
          <div className="controls">
            {[
              ["reference", "Shipment reference"],
              ["name", "Recipient"],
              ["address", "Street and number"],
              ["city", "City"],
              ["zip", "Postal code"],
              ["phone", "Phone"],
            ].map(([k, l]) => (
              <label key={k}>
                {l} <input required name={k} />
              </label>
            ))}
            <label>
              Country{" "}
              <select name="country">
                <option>GR</option>
                <option>CY</option>
                <option>BG</option>
              </select>
            </label>
            <label>
              Packed weight (kg){" "}
              <input
                required
                name="weight"
                type="number"
                min=".01"
                step=".01"
              />
            </label>
            <label>
              COD (€){" "}
              <input
                name="cod"
                type="number"
                defaultValue="0"
                min="0"
                step=".01"
              />
            </label>
            <label>
              Environment{" "}
              <select name="environment">
                <option value="test">Test</option>
                <option value="live">Live</option>
              </select>
            </label>
            <button disabled={busy} name="op" value="manual">
              Create manual voucher
            </button>
          </div>
        </Form>
      </section>
      <section>
        <h2>Order tags</h2>
        <Form method="post">
          <div className="controls">
            {tagStates.map((status) => (
              <label key={status}>
                {status}{" "}
                <input
                  name={status}
                  defaultValue={rules[status] || ""}
                  placeholder="No tag"
                />
              </label>
            ))}
            <button name="op" value="tags" disabled={busy}>
              Save tag rules
            </button>
          </div>
        </Form>
      </section>
    </main>
  );
}
