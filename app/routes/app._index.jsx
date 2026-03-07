import { useMemo } from "react";
import { useLocation } from "react-router";

export default function AppHome() {
  const location = useLocation();

  // Preserva shop/host/embedded dalla URL corrente dell'app
  const vouchersHref = useMemo(() => {
    const qs = location.search || "";
    const base = "/app/vouchers";
    return qs ? `${base}${qs}` : base;
  }, [location.search]);

  const acsVouchersHref = useMemo(() => {
    const qs = location.search || "";
    const base = "/app/acs-vouchers";
    return qs ? `${base}${qs}` : base;
  }, [location.search]);

  return (
    <div
      style={{
        maxWidth: 820,
        margin: "24px auto",
        padding: 16,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 6 }}>Shipping Labels</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        Manage EasyMail and ACS shipping labels from Shopify Admin.
      </p>

      <div
        style={{
          border: "1px solid #e5e5e5",
          borderRadius: 14,
          padding: 16,
          background: "#fff",
        }}
      >
        <h2 style={{ fontSize: 16, margin: "0 0 10px 0" }}>
          How to generate labels
        </h2>
        <ol style={{ margin: 0, paddingLeft: 18, color: "#333", lineHeight: 1.55 }}>
          <li>Go to <b>Orders</b>.</li>
          <li>Open an order that you want to ship.</li>
          <li>Click <b>More actions</b> (top right).</li>
          <li>Select <b>EasyMail Labels</b> or <b>ACS Labels</b>.</li>
          <li>Choose the number of pieces (1–5) and click <b>Generate</b>.</li>
          <li>Use <b>View/Print</b> to open the label and print it.</li>
        </ol>
      </div>

      {/* EASYMAIL */}
      <div
        style={{
          marginTop: 16,
          border: "1px solid #e5e5e5",
          borderRadius: 14,
          padding: 16,
          background: "#fff",
        }}
      >
        <h2 style={{ fontSize: 16, margin: "0 0 10px 0" }}>EasyMail Daily Labels</h2>
        <p style={{ marginTop: 0, color: "#555" }}>
          View all EasyMail labels created on a specific day, cancel vouchers,
          refresh the list, and print the end-of-day PDF list.
        </p>

        <s-link
          href={vouchersHref}
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
          Open EasyMail Daily Labels
        </s-link>
      </div>

      {/* ACS */}
      <div
        style={{
          marginTop: 16,
          border: "1px solid #e5e5e5",
          borderRadius: 14,
          padding: 16,
          background: "#fff",
        }}
      >
        <h2 style={{ fontSize: 16, margin: "0 0 10px 0" }}>ACS Daily Labels</h2>
        <p style={{ marginTop: 0, color: "#555" }}>
          View all ACS labels created for a pickup date, reprint vouchers,
          cancel shipments (if still allowed), and generate or print the pickup list.
        </p>

        <s-link
          href={acsVouchersHref}
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
          Open ACS Daily Labels
        </s-link>
      </div>
    </div>
  );
}
