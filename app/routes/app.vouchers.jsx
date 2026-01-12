import { useMemo, useState, useEffect } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

const NS = "easymail";
const KEY_VOUCHER = "voucher_number";
const KEY_CREATED_AT = "created_at";
const KEY_PIECES = "pieces";
const KEY_HISTORY = "voucher_history";

const ATHENS_TZ = "Europe/Athens";

// Live JSON CancelVoucher (tuo live: JSON2)
const ESM_CANCEL_VOUCHER =
  "https://webservices.easy-mail.gr/WcfServiceJSON2/Service1.svc/CancelVoucher";

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

function pickMessage(j) {
  if (!j) return "";
  if (typeof j.Message === "string" && j.Message.trim()) return j.Message.trim();
  if (Array.isArray(j.Messages) && j.Messages.length) return j.Messages.filter(Boolean).join(" | ");
  return "";
}

// Cancel server-side (no cookie/iframe issues)
async function callCancelEasyMail(number) {
  if (!process.env.EASYMAIL_USER || !process.env.EASYMAIL_PASSWORD) {
    return { ok: false, message: "Missing EASYMAIL_USER / EASYMAIL_PASSWORD in .env" };
  }

  const payloads = [
    {
      Number: Number(number),
      Credential: { UserName: process.env.EASYMAIL_USER, Password: process.env.EASYMAIL_PASSWORD },
    },
    {
      ShipmentNumber: Number(number),
      Credential: { UserName: process.env.EASYMAIL_USER, Password: process.env.EASYMAIL_PASSWORD },
    },
    {
      Voucher: { ShipmentNumber: Number(number) },
      Credential: { UserName: process.env.EASYMAIL_USER, Password: process.env.EASYMAIL_PASSWORD },
    },
  ];

  let lastPreview = "";
  for (const bodyObj of payloads) {
    const resp = await fetch(ESM_CANCEL_VOUCHER, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(bodyObj),
    });

    const txt = await resp.text();
    lastPreview = (txt || "").slice(0, 400);

    let j;
    try {
      j = JSON.parse(txt);
    } catch {
      continue;
    }

    if (typeof j?.Result === "boolean") {
      return {
        ok: true,
        result: j.Result,
        canceled: Boolean(j.Canceled),
        message: pickMessage(j) || (j.Result ? "OK" : "Cancel failed"),
        raw: j,
      };
    }
  }

  return {
    ok: false,
    message: "EasyMail CancelVoucher did not return a valid JSON response (or unknown payload format).",
    preview: lastPreview,
  };
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
              tags
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

      const tags = Array.isArray(o?.tags) ? o.tags : [];
      const hasCod = tags.some((t) => String(t || "").trim().toUpperCase() === "COD");

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
          hasCod,
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
          hasCod,
        });
      }
    }
  }

  const deduped = uniqRows(rows);
  deduped.sort((a, b) => (b.createdAtIso || "").localeCompare(a.createdAtIso || ""));

  return { date, rows: deduped };
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const form = await request.formData();
  const intent = safeStr(form.get("intent"));
  const voucherNumberRaw = safeStr(form.get("voucherNumber")).trim();
  const date = safeStr(form.get("date")) || ymdInTz(new Date(), ATHENS_TZ);

  if (intent !== "cancel") {
    return { ok: false, message: "Unknown action.", date };
  }

  if (!voucherNumberRaw) {
    return { ok: false, message: "Please enter a voucher number.", date };
  }

  const num = Number(voucherNumberRaw);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, message: "Invalid voucher number.", date };
  }

  const out = await callCancelEasyMail(num);

  if (!out.ok) {
    const extra = out.preview ? ` Preview: ${out.preview}` : "";
    return { ok: false, message: `Cancel failed for ${voucherNumberRaw}: ${out.message}${extra}`, date };
  }

  if (!out.result) {
    return { ok: false, message: `Cancel failed for ${voucherNumberRaw}: ${out.message}`, date };
  }

  return { ok: true, message: `Voucher ${voucherNumberRaw} cancelled successfully.`, date };
};

export default function VouchersPage() {
  const { date, rows } = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();

  const [selectedDate, setSelectedDate] = useState(actionData?.date || date);
  const [cancelNumber, setCancelNumber] = useState("");

  const isLoading = nav.state !== "idle";
  const isSubmitting = nav.state === "submitting";

  // ✅ dopo submit (success o error) svuotiamo il campo, così puoi cancellarne un altro subito
  useEffect(() => {
    if (actionData?.message) {
      setCancelNumber("");
    }
  }, [actionData?.message]);

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

      {/* Status banner */}
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
          {actionData.message}
        </div>
      )}

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
            if (next) reloadToDate(next);
          }}
          style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd" }}
        />
        {isLoading && <span style={{ fontSize: 12, color: "#666" }}>Loading…</span>}
      </div>

      {/* ✅ Cancel voucher (manual) */}
      <div style={{ marginBottom: 16, border: "1px solid #eee", borderRadius: 14, padding: 12, background: "#fff" }}>
        <Form method="post" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input type="hidden" name="intent" value="cancel" />
          <input type="hidden" name="date" value={selectedDate} />

          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 13, color: "#333" }}>Cancel voucher (manual):</div>
            <input
              name="voucherNumber"
              value={cancelNumber}
              onChange={(e) => setCancelNumber(e.target.value)}
              placeholder="e.g. 53708701893"
              style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", minWidth: 240 }}
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid #ddd",
              background: isSubmitting ? "#f5f5f5" : "#111",
              color: isSubmitting ? "#999" : "#fff",
              cursor: isSubmitting ? "default" : "pointer",
              fontSize: 14,
              marginTop: 18,
            }}
          >
            {isSubmitting ? "..." : "Cancel"}
          </button>

          {/* ✅ Clear (reset campo) */}
          <button
            type="button"
            onClick={() => setCancelNumber("")}
            style={{
              padding: "10px 14px",
              borderRadius: 12,
              border: "1px solid #ddd",
              background: "#fff",
              cursor: "pointer",
              fontSize: 14,
              marginTop: 18,
            }}
          >
            Clear
          </button>

          <div style={{ fontSize: 12, color: "#666", marginTop: 18 }}>
            Note: cancellation is possible only if the shipment has not been processed by the courier.
          </div>
        </Form>
      </div>

      {/* Table */}
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
              <th style={{ padding: "10px 12px", fontSize: 12, color: "#555" }}>COD</th>
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
                <td style={{ padding: "10px 12px", fontSize: 12 }}>
                  {r.hasCod ? (
                    <span
                      style={{
                        display: "inline-block",
                        padding: "4px 8px",
                        borderRadius: 999,
                        border: "1px solid #ddd",
                        background: "#fff",
                        fontWeight: 600,
                      }}
                    >
                      COD
                    </span>
                  ) : (
                    ""
                  )}
                </td>
              </tr>
            ))}

            {!rows.length && (
              <tr>
                <td colSpan={5} style={{ padding: 18, fontSize: 13, color: "#777" }}>
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

