import React from "react";
import { useLoaderData } from "react-router";
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
  if (j?.errors?.length) throw new Error(j.errors.map((e) => e.message).join(" | "));
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

      if (currentVoucher && isWithinDay(currentCreated, date)) {
        rows.push({
          orderName: safeStr(o.name),
          voucherNumber: currentVoucher,
          createdAtIso: currentCreated,
          pieces: currentPieces,
        });
      }

      for (const h of history) {
        const vn = safeStr(h?.voucherNumber);
        const ca = safeStr(h?.createdAtIso);
        const pcs = safeStr(h?.pieces) || "1";
        if (!vn) continue;
        if (!isWithinDay(ca, date)) continue;
        rows.push({
          orderName: safeStr(o.name),
          voucherNumber: vn,
          createdAtIso: ca,
          pieces: pcs,
        });
      }
    }
  }

  rows.sort((a, b) => (b.createdAtIso || "").localeCompare(a.createdAtIso || ""));
  return { date, rows };
};

export default function VouchersPrint() {
  const { date, rows } = useLoaderData();

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", color: "#111" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 18 }}>EasyMail — Daily labels</h1>
          <div style={{ marginTop: 6, color: "#555", fontSize: 13 }}>
            Date: <b>{date}</b> • Total: <b>{rows.length}</b>
          </div>
        </div>

        <button
          onClick={() => window.print()}
          style={{
            padding: "10px 14px",
            borderRadius: 12,
            border: "1px solid #ddd",
            background: "#111",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Print / Save as PDF
        </button>
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 14, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ background: "#f6f6f6" }}>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e5e5" }}>Order</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e5e5" }}>Voucher</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e5e5" }}>Created</th>
              <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e5e5" }}>Pieces</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.orderName}-${r.voucherNumber}`}>
                <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0" }}>{r.orderName}</td>
                <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0" }}><b>{r.voucherNumber}</b></td>
                <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0" }}>
                  {r.createdAtIso ? new Date(r.createdAtIso).toLocaleString() : ""}
                </td>
                <td style={{ padding: 10, borderBottom: "1px solid #f0f0f0" }}>{r.pieces || "1"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: 16, color: "#666" }}>
                  No labels found for this date.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: "#777" }}>
        Generated from Shopify metafields (easymail.created_at / easymail.voucher_number / easymail.voucher_history).
      </div>
    </div>
  );
}

