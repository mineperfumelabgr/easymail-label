import { useMemo, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

const NS = "easymail";
const KEY_VOUCHER = "voucher_number";
const KEY_CREATED_AT = "created_at";
const KEY_PIECES = "pieces";
const KEY_HISTORY = "voucher_history";

function ymd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function safeStr(v) {
  return String(v ?? "");
}
function parseHistory(raw) {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}
function isWithinDay(iso, dateStr) {
  if (!iso) return false;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return false;
  return ymd(dt) === dateStr;
}

async function adminGraphql(admin, query, variables) {
  const r = await admin.graphql(query, { variables });
  const j = await r.json();
  if (j?.errors?.length) {
    throw new Error(j.errors.map((e) => e.message).join(" | "));
  }
  return j;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const date = url.searchParams.get("date") || ymd(new Date());

  let hasNext = true;
  let cursor = null;
  const rows = [];

  while (hasNext) {
    const q = `#graphql
      query Orders($first: Int!, $after: String) {
        orders(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
          edges {
            cursor
            node {
              id
              name
              updatedAt
              mfVoucher: metafield(namespace: "${NS}", key: "${KEY_VOUCHER}") { value }
              mfCreated: metafield(namespace: "${NS}", key: "${KEY_CREATED_AT}") { value }
              mfPieces: metafield(namespace: "${NS}", key: "${KEY_PIECES}") { value }
              mfHistory: metafield(namespace: "${NS}", key: "${KEY_HISTORY}") { value }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `;

    const json = await adminGraphql(admin, q, { first: 100, after: cursor });
    const edges = json?.data?.orders?.edges || [];
    hasNext = json?.data?.orders?.pageInfo?.hasNextPage || false;

    if (!edges.length) break;

    for (const e of edges) {
      cursor = e.cursor;
      const o = e.node;

      // stop early: once orders updatedAt are older than the requested date
      const updatedAt = new Date(o.updatedAt);
      if (!Number.isNaN(updatedAt.getTime())) {
        const updatedYmd = ymd(updatedAt);
        if (updatedYmd < date) {
          hasNext = false;
          break;
        }
      }

      const currentVoucher = safeStr(o?.mfVoucher?.value);
      const currentCreated = safeStr(o?.mfCreated?.value);
      const currentPieces = safeStr(o?.mfPieces?.value) || "1";
      const history = parseHistory(safeStr(o?.mfHistory?.value));

      // current
      if (currentVoucher && isWithinDay(currentCreated, date)) {
        rows.push({
          orderName: safeStr(o.name),
          orderId: safeStr(o.id),
          voucherNumber: currentVoucher,
          createdAtIso: currentCreated,
          pieces: currentPieces,
          viewUrl: `/api/easymail-label-pdf?number=${encodeURIComponent(currentVoucher)}&inline=1`,
        });
      }

      // history
      for (const h of history) {
        const vn = safeStr(h?.voucherNumber);
        const ca = safeStr(h?.createdAtIso);
        const pcs = safeStr(h?.pieces) || "1";
        if (!vn) continue;
        if (!isWithinDay(ca, date)) continue;

        rows.push({
          orderName: safeStr(o.name),
          orderId: safeStr(o.id),
          voucherNumber: vn,
          createdAtIso: ca,
          pieces: pcs,
          viewUrl: `/api/easymail-label-pdf?number=${encodeURIComponent(vn)}&inline=1`,
        });
      }
    }
  }

  rows.sort((a, b) => (b.createdAtIso || "").localeCompare(a.createdAtIso || ""));

  return { date, rows };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const form = await request.formData();
  const intent = safeStr(form.get("intent"));
  const voucherNumber = safeStr(form.get("voucherNumber")).trim();
  const date = safeStr(form.get("date")) || ymd(new Date());

  if (intent !== "cancel") {
    return { ok: false, message: "Unknown action.", date };
  }

  if (!voucherNumber) {
    return { ok: false, message: "Please enter a voucher number.", date };
  }

  // Call your existing cancel endpoint using same-origin + current session cookies
  const u = new URL(request.url);
  u.pathname = "/api/easymail-cancel-voucher";
  u.search = "";
  u.searchParams.set("number", voucherNumber);

  const cookie = request.headers.get("cookie") || "";

  const resp = await fetch(u.toString(), {
    method: "GET",
    headers: { cookie },
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
  // ignore malformed JSON
}


  const success = json?.success === true || json?.Result === true || resp.ok;

  if (!success) {
    const msg =
      json?.message ||
      json?.Message ||
      (text ? text.slice(0, 200) : "") ||
      "Cancel failed.";
    return { ok: false, message: `Cancel failed for ${voucherNumber}: ${msg}`, date };
  }

  return { ok: true, message: `Voucher ${voucherNumber} cancelled successfully.`, date };
};

export default function VouchersPage() {
  const { date, rows } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();

  const [selectedDate, setSelectedDate] = useState(actionData?.date || date);
  const isSubmitting = nav.state === "submitting";

  const refreshHref = useMemo(() => {
    return `/app/vouchers?date=${encodeURIComponent(selectedDate)}`;
  }, [selectedDate]);

  const printableHref = useMemo(() => {
    return `/app/vouchers-print?date=${encodeURIComponent(selectedDate)}`;
  }, [selectedDate]);

  return (
    <div style={{ maxWidth: 980, margin: "24px auto", padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 6 }}>Daily labels</h1>
      <p style={{ marginTop: 0, color: "#666" }}>
        Labels created on a specific day (based on Shopify metafields).
      </p>

      {/* Banner */}
      {actionData?.message && (
        <div
          style={{
            marginBottom: 12,
            padding: 12,
            borderRadius: 12,
            border: "1px solid",
            borderColor: actionData.ok ? "#b7eb8f" : "#ffa39e",
            background: actionData.ok ? "#f6ffed" : "#fff1f0",
            color: "#111",
          }}
        >
          {actionData.message}{" "}
          <span style={{ color: "#666" }}>
            (Click <b>Refresh</b> to update the list)
          </span>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
<label htmlFor="dateInput" style={{ fontSize: 13, color: "#333" }}>Date:</label>
<input
  id="dateInput"
  type="date"
  value={selectedDate}
  onChange={(e) => setSelectedDate(e.target.value)}
  style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd" }}
/>
        </div>

        <s-link
          href={refreshHref}
          style={{
            display: "inline-block",
            padding: "10px 14px",
            borderRadius: 12,
            background: "#111",
            color: "#fff",
            textDecoration: "none",
            fontSize: 14,
          }}
        >
          Refresh
        </s-link>

        <s-link
          href={printableHref}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-block",
            padding: "10px 14px",
            borderRadius: 12,
            background: "#fff",
            color: "#111",
            textDecoration: "none",
            fontSize: 14,
            border: "1px solid #ddd",
          }}
        >
          Printable view (Save as PDF)
        </s-link>
      </div>

      {/* Table */}
      <div style={{ border: "1px solid #e5e5e5", borderRadius: 14, overflow: "hidden", background: "#fff" }}>
        <div style={{ padding: 12, borderBottom: "1px solid #eee", fontSize: 13, color: "#666" }}>
          Found <b>{rows.length}</b> label(s) for <b>{selectedDate}</b>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#fafafa" }}>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Order</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Voucher</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Created</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Pieces</th>
                <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #eee" }}>Actions</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((r) => (
                <tr key={`${r.orderId}-${r.voucherNumber}`}>
                  <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0", whiteSpace: "nowrap" }}>
                    {r.orderName}
                  </td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0", whiteSpace: "nowrap" }}>
                    <b>{r.voucherNumber}</b>
                  </td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0", whiteSpace: "nowrap" }}>
                    {r.createdAtIso ? new Date(r.createdAtIso).toLocaleString() : ""}
                  </td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0", whiteSpace: "nowrap" }}>
                    {r.pieces || "1"}
                  </td>
                  <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <a
                        href={r.viewUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "inline-block",
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid #ddd",
                          textDecoration: "none",
                          color: "#111",
                          background: "#fff",
                        }}
                      >
                        View/Print
                      </a>

                      <Form method="post" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input type="hidden" name="intent" value="cancel" />
                        <input type="hidden" name="date" value={selectedDate} />
                        <input
                          name="voucherNumber"
                          defaultValue={r.voucherNumber}
                          style={{
                            width: 150,
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid #ddd",
                          }}
                        />
                        <button
                          type="submit"
                          disabled={isSubmitting}
                          style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid #ddd",
                            background: "#fff1f0",
                            color: "#111",
                            cursor: "pointer",
                          }}
                        >
                          {isSubmitting ? "..." : "Cancel"}
                        </button>
                      </Form>
                    </div>
                  </td>
                </tr>
              ))}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 16, color: "#666" }}>
                    No labels found for this date.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ padding: 12, fontSize: 12, color: "#777", borderTop: "1px solid #eee" }}>
          Note: the list is based on Shopify metafields (current voucher + voucher_history). After cancelling a voucher, click <b>Refresh</b>.
        </div>
      </div>
    </div>
  );
}

