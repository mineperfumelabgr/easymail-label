import React, { useMemo, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { getSessionToken } from "@shopify/app-bridge/utilities";

export default function AppHome() {
  const app = useAppBridge();
  const [status, setStatus] = useState("");

  const todayStr = useMemo(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }, []);

  const csvUrl = useMemo(() => {
    return `/api/easymail-vouchers-csv?date=${encodeURIComponent(todayStr)}`;
  }, [todayStr]);

  async function downloadCsv() {
    setStatus("");
    try {
      // ✅ Session token (works even when cookies are blocked in iframes)
      const token = await getSessionToken(app);

      const res = await fetch(csvUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`CSV download failed (${res.status}). ${t.slice(0, 200)}`);
      }

      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);

      // Download with filename (fallback if header not respected)
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `easymail-vouchers-${todayStr}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      // Cleanup
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);

      setStatus("CSV downloaded successfully.");
    } catch (e) {
      setStatus(e?.message || "CSV download error.");
    }
  }

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
      </div>

      <div style={{ marginTop: 16, border: "1px solid #e5e5e5", borderRadius: 14, padding: 16, background: "#fff" }}>
        <h2 style={{ fontSize: 16, margin: "0 0 10px 0" }}>Daily export</h2>
        <p style={{ marginTop: 0, color: "#555" }}>
          Download the CSV file with all vouchers generated today.
        </p>

        <button
          onClick={downloadCsv}
          style={{
            padding: "10px 14px",
            borderRadius: 12,
            background: "#111",
            color: "#fff",
            border: "none",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Download today’s CSV ({todayStr})
        </button>

        {status && (
          <div style={{ marginTop: 10, fontSize: 13, color: "#555" }}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}

