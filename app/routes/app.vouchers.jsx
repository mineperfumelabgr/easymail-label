import { useMemo, useState } from "react";
import { useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

const NS = "easymail";
const KEY_VOUCHER = "voucher_number";
const KEY_CREATED_AT = "created_at";
const KEY_PIECES = "pieces";
const KEY_HISTORY = "voucher_history";

const ATHENS_TZ = "Europe/Athens";

// Build YYYY-MM-DD in a specific timezone
function ymdInTz(date, timeZone = ATHENS_TZ) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Format ISO datetime in Athens timezone: YYYY-MM-DD HH:mm
function formatAthens(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ATHENS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  // en-GB gives DD/MM/YYYY parts; we rebuild stable format
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
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

function isWithinAthensDay(iso, dateStr) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return ymdInTz(d, ATHENS_TZ) === dateStr;
}

function uniqRows(rows) {
  // dedup per orderId + voucherNumber
  const map = new Map();
  for (const r of rows || []) {
    const key = `${r.orderId}::${r.voucherNumber}`;
    if (!map.has(key)) map.set(key, r);
  }
  return Array.from(map.values());
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

  // Default date: TODAY in Athens timezone
  const defaultDate = ymdInTz(new Date(), ATHENS_TZ);
  const date = url.searchParams.get("date") || defaultDate;

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

      // Early stop: compare UPDATED_AT day in Athens
      const updatedAt = new Date(o.updatedAt);
      if (!Number.isNaN(updatedAt.getTime())) {
        const updatedYmdAthens = ymdInTz(updatedAt, ATHENS_TZ);
        if (updatedYmdAthens < date) {
          hasNext = false;
          break;
        }
      }

      const currentVoucher = safeStr(o?.mfVoucher?.value);
      const currentCreated = safeStr(o?.mfCreated?.value);
      const currentPieces = safeStr(o?.mfPieces?.value) || "1";
      const history = parseHistory(safeStr(o?.mfHistory?.value));

      // current
      if (currentVoucher && isWithinAthensDay(currentCreated, date)) {
        rows.push({
          orderName: safeStr(o.name),
          orderId: safeStr(o.id),
          voucherNumber: currentVoucher,
          createdAtIso: currentCreated,
          pieces: currentPieces,
        });
      }

      // history
      for (const h of history) {
        const vn = safeStr(h?.voucherNumber);
        const ca = safeStr(h?.createdAtIso);
        const pcs = safeStr(h?.pieces) || "1";
        if (!vn) continue;
        if (!isWithinAthensDay(ca, date)) continue;

        rows.push({
          orderName: safeStr(o.name),
          orderId: safeStr(o.id),
          voucherNumber: vn,
          createdAtIso: ca,
          pieces: pcs,
        });
      }
    }
  }

  const deduped = uniqRows(rows);

  // Sort by createdAtIso desc (string compare ok for ISO)
  deduped.sort((a, b) => (b.createdAtIso || "").localeCompare(a.createdAtIso || ""));

  return { date, rows: deduped };
};

export default function VouchersPage() {
  const { date, rows } = useLoaderData();
  const nav = useNavigation();

  const [selectedDate, setSelectedDate] = useState(date);
  const isLoading = nav.state !== "idle";

  const reloadToDate = (nextDate) => {
    const u = new URL(window.location.href);
    u.searchParams.set("date", nextDate);
    window.location.assign(u.toString());
  };

  const title = useMemo(() => {
    return `Daily labels — ${selectedDate}`;
  }, [selectedDate]);

  return (
    <div
      style={{
        maxWidth: 980,
        margin: "24px auto",
        padding: 16,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 20, marginBottom: 6 }}>{title}</h1>
      <p style={{ marginTop: 0, color: "#666" }}>
        Times are shown in <b>Europe/Athens</b>.
      </p>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <label htmlFor="dateInput" style={{ fontSize: 13, color: "#333" }}>
          Date:
        </label>
        <input
          id="dateInput"
          type="date"
          value={selectedDate}
          onChange={(e) => {
            const next = e.target.value;
            setSelectedDate(next);
            // auto reload (no button)
            if (next) reloadToDate(next);
          }}
          style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd" }}
        />
        {isLoading && <span style={{ fontSize: 12, color: "#666" }}>Loading…</span>}
      </div>

      <div style={{ border: "1px solid #eee", borderRadius: 14, overflow: "hidden", background: "#fff" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid #eee", fontSize: 13, color: "#555" }}>
          Total: <b>{rows.length}</b>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#fafafa", textAlign: "left" }}>
              <th style={{ padding: "10px 12px", fontSize: 12, color: "#555" }}>Order</th>
              <th style={{ padding: "10px 12px", fontSize: 12, color: "#555" }}>Voucher</th>
              <th style={{ padding: "10px 12px", fontSize: 12, color: "#555" }}>Pieces</th>
              <th style={{ padding: "10px 12px", fontSize: 12, color: "#555" }}>Created (Athens)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.orderId}::${r.voucherNumber}`} style={{ borderTop: "1px solid #f0f0f0" }}>
                <td style={{ padding: "10px 12px", fontSize: 13 }}>{r.orderName}</td>
                <td
                  style={{
                    padding: "10px 12px",
                    fontSize: 13,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  }}
                >
                  {r.voucherNumber}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 13 }}>{r.pieces || "1"}</td>
                <td style={{ padding: "10px 12px", fontSize: 12, color: "#666" }}>
                  {formatAthens(r.createdAtIso)}
                </td>
              </tr>
            ))}

            {!rows.length && (
              <tr>
                <td colSpan={4} style={{ padding: 18, fontSize: 13, color: "#777" }}>
                  No labels found for this day.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

