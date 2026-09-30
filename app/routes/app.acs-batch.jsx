import { useEffect, useMemo, useState } from "react";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

function safeStr(value) {
  return String(value ?? "").trim();
}

function todayLocalYMD() {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function clampPieces(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "1";
  return String(Math.max(1, Math.min(5, Math.floor(parsed))));
}

function decodeBatchResults(value) {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const orderIds = (url.searchParams.get("orderIds") || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (orderIds.length > 100) {
    throw new Response("Select no more than 100 orders at once.", {
      status: 400,
    });
  }

  if (!orderIds.length) return { orders: [] };

  const response = await admin.graphql(
    `#graphql
      query SelectedAcsBatchOrders($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            name
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            customer { firstName lastName }
            shippingAddress { name }
            lineItems(first: 50) {
              nodes { title variantTitle quantity }
            }
          }
        }
      }
    `,
    { variables: { ids: orderIds } },
  );
  const payload = await response.json();
  if (payload?.errors?.length) {
    throw new Response(
      payload.errors.map((error) => error.message).join(" | "),
      { status: 500 },
    );
  }

  const orders = (payload?.data?.nodes || []).filter(Boolean).map((order) => {
    const shippingName = safeStr(order.shippingAddress?.name);
    const customerName = [order.customer?.firstName, order.customer?.lastName]
      .map(safeStr)
      .filter(Boolean)
      .join(" ");

    return {
      orderId: order.id,
      orderName: safeStr(order.name) || "Order",
      customerName: shippingName || customerName || "Customer not listed",
      lineItems: (order.lineItems?.nodes || []).map((item) => ({
        title: safeStr(item.title),
        variantTitle: safeStr(item.variantTitle),
        quantity: Number(item.quantity) || 0,
      })),
      total: safeStr(order.currentTotalPriceSet?.shopMoney?.amount),
      currencyCode: safeStr(
        order.currentTotalPriceSet?.shopMoney?.currencyCode,
      ),
    };
  });

  return { orders };
}

export default function AcsBatchPage() {
  const { orders: initialOrders } = useLoaderData();
  const today = useMemo(todayLocalYMD, []);
  const [orders, setOrders] = useState(() =>
    initialOrders.map((order) => ({
      ...order,
      pieces: "1",
      pickupDate: today,
    })),
  );
  const [loadingBatch, setLoadingBatch] = useState(false);
  const [batchError, setBatchError] = useState("");
  const [batchResults, setBatchResults] = useState(null);
  const [pdfUrl, setPdfUrl] = useState("");

  useEffect(
    () => () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    },
    [pdfUrl],
  );

  function updateOrder(orderId, updates) {
    setOrders((current) =>
      current.map((order) =>
        order.orderId === orderId ? { ...order, ...updates } : order,
      ),
    );
    setBatchResults(null);
    setBatchError("");
    setPdfUrl("");
  }

  async function generateBatch() {
    setLoadingBatch(true);
    setBatchError("");
    setBatchResults(null);
    setPdfUrl("");

    try {
      const response = await fetch("/api/acs-batch-merge-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orders: orders.map((order) => ({
            orderId: order.orderId,
            orderName: order.orderName,
            pieces: clampPieces(order.pieces),
            pickupDate: order.pickupDate,
          })),
        }),
      });

      const contentType = response.headers.get("Content-Type") || "";
      if (contentType.includes("application/pdf")) {
        const results = decodeBatchResults(
          response.headers.get("X-ACS-Batch-Results"),
        );
        const pdf = await response.blob();
        if (!pdf.size) throw new Error("ACS returned an empty batch PDF.");
        setBatchResults(results || { successes: [], errors: [] });
        setPdfUrl(URL.createObjectURL(pdf));
      } else {
        const payload = await response.json().catch(() => null);
        const results = payload?.results || null;
        if (results) setBatchResults(results);
        if (!response.ok || !payload?.success) {
          const firstError = results?.errors?.[0]?.message;
          setBatchError(
            firstError || payload?.message || "No labels could be generated.",
          );
        }
      }
    } catch (error) {
      setBatchError(error?.message || "Unexpected ACS batch error.");
    } finally {
      setLoadingBatch(false);
    }
  }

  function lineSummary(lineItems) {
    return lineItems.length
      ? lineItems
          .map((item) => {
            const variant =
              item.variantTitle && item.variantTitle !== "Default Title"
                ? ` — ${item.variantTitle}`
                : "";
            return `${item.title}${variant} × ${item.quantity}`;
          })
          .join(", ")
      : "Order details unavailable";
  }

  return (
    <main style={{ padding: 24, width: "100%", boxSizing: "border-box" }}>
      <h1 style={{ fontSize: 26, margin: "0 0 8px" }}>ACS batch labels</h1>
      <p style={{ margin: "0 0 20px", color: "#555" }}>
        {orders.length} selected order(s). Review each order, set pieces and
        pickup date, then generate labels.
      </p>

      {!orders.length ? (
        <div style={{ padding: 16, border: "1px solid #ddd", borderRadius: 8 }}>
          No selected orders were received. Close this page, select orders in
          Shopify, and open ACS Batch Labels again.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {orders.map((order) => (
            <section
              key={order.orderId}
              style={{
                border: "1px solid #ddd",
                borderRadius: 10,
                padding: 16,
                background: "#fff",
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
                {order.orderName} — {order.customerName}
              </div>
              <div style={{ color: "#555", marginBottom: 14 }}>
                {lineSummary(order.lineItems)}
                {order.total
                  ? ` • ${order.total} ${order.currencyCode || ""}`
                  : ""}
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 320px))",
                  gap: 14,
                }}
              >
                <label style={{ display: "grid", gap: 6, fontWeight: 600 }}>
                  Pieces
                  <input
                    type="number"
                    min="1"
                    max="5"
                    step="1"
                    value={order.pieces}
                    onChange={(event) =>
                      updateOrder(order.orderId, {
                        pieces: clampPieces(event.target.value),
                      })
                    }
                    style={{
                      padding: 10,
                      border: "1px solid #aaa",
                      borderRadius: 6,
                      fontWeight: 400,
                    }}
                  />
                </label>
                <label style={{ display: "grid", gap: 6, fontWeight: 600 }}>
                  Pickup date
                  <input
                    type="date"
                    value={order.pickupDate}
                    onChange={(event) =>
                      updateOrder(order.orderId, {
                        pickupDate: event.target.value,
                      })
                    }
                    style={{
                      padding: 10,
                      border: "1px solid #aaa",
                      borderRadius: 6,
                      fontWeight: 400,
                    }}
                  />
                </label>
              </div>
            </section>
          ))}
        </div>
      )}

      {batchResults?.errors?.length ? (
        <div
          style={{
            marginTop: 18,
            padding: 16,
            border: "1px solid #e5bd79",
            borderRadius: 8,
            background: "#fff8e8",
          }}
        >
          <strong>Some orders could not be processed:</strong>
          <ul style={{ marginBottom: 0 }}>
            {batchResults.errors.map((item) => (
              <li key={item.orderId}>
                {item.orderName}: {item.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {batchError ? (
        <div
          role="alert"
          style={{
            marginTop: 18,
            padding: 16,
            border: "1px solid #d99",
            borderRadius: 8,
            background: "#fff1f1",
          }}
        >
          {batchError}
        </div>
      ) : null}

      {batchResults?.successes?.length ? (
        <div
          style={{
            marginTop: 18,
            padding: 16,
            border: "1px solid #b9dfb9",
            borderRadius: 8,
            background: "#eef8ee",
          }}
        >
          {batchResults.successes.length} order(s) ready. Open the combined PDF
          to print all successful labels together.
        </div>
      ) : null}

      <div
        style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 20 }}
      >
        <button
          type="button"
          onClick={generateBatch}
          disabled={
            !orders.length ||
            loadingBatch ||
            !orders.every((order) =>
              /^\d{4}-\d{2}-\d{2}$/.test(order.pickupDate),
            )
          }
          style={{
            padding: "11px 16px",
            border: 0,
            borderRadius: 7,
            background: "#008060",
            color: "white",
            fontWeight: 700,
            cursor: loadingBatch ? "wait" : "pointer",
          }}
        >
          {loadingBatch ? "Generating labels…" : "Generate ACS labels"}
        </button>
        {pdfUrl ? (
          <a
            href={pdfUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-block",
              padding: "11px 16px",
              border: "1px solid #999",
              borderRadius: 7,
              color: "#222",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            Open combined labels PDF
          </a>
        ) : null}
      </div>
    </main>
  );
}
