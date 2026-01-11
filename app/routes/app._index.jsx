import React, { useMemo } from "react";

export default function AppHome() {
  const todayStr = useMemo(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }, []);

  const csvHref = useMemo(() => {
    return `/api/easymail-vouchers-csv?date=${encodeURIComponent(todayStr)}`;
  }, [todayStr]);

  return (
    <div style={{ maxWidth: 820, margin: "24px auto", padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <h1 style={{ fontSize: 22, marginBottom: 6 }}>EasyMail Label</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        Quick guide to use the app in Shopify Admin.
      </p>

      <div style={{ border: "1px solid #e5e5e5", borderRadius: 14, padding: 16, background: "#fff" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 10px 0" }}>How to generate labels</h2>
        <ol style={{ margin: 0, paddingLeft: 18, color: "#333", lineHeight: 1.55 }}>
          <li>Go to <b>Orders</b>.</li>
          <li>Open an order that you want to ship.</li>
          <li>Click <b>More actions</b> (top right).</li>
          <li>Select <b>EasyMail Labels</b>.</li>
          <li>Choose the number of pieces (1–5) and click <b>Generate</b>.</li>
          <li>Use <b>View/Print</b> to open the label and print it.</li>
        </ol>

        <div style={{ marginTop: 14, fontSize: 13, color: "#666" }}>
          Tip: If a label already exists, the extension will show buttons to view/print existing labels or generate a new one (keeping the old).
        </div>
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 14, padding: 16, background: "#fff" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 10px 0" }}>Daily export</h2>
        <p style={{ marginTop: 0, color: "#555" }}>
          Download the CSV file with all vouchers generated today.
        </p>

        <a
          href={csvHref}
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
          Download today’s CSV ({todayStr})
        </a>
      </div>

      <div style={{ marginTop: 18, fontSize: 12, color: "#777" }}>
        Note: CSV uses your Shopify session. If you open this link outside Shopify Admin, you may be asked to login.
      </div>
    </div>
  );
}

