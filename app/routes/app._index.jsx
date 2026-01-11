// no React import needed

export default function AppHome() {
  return (
    <div
      style={{
        maxWidth: 820,
        margin: "24px auto",
        padding: 16,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 6 }}>EasyMail Label</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        Quick guide to use the app in Shopify Admin.
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
          <li>Select <b>EasyMail Labels</b>.</li>
          <li>Choose the number of pieces (1–5) and click <b>Generate</b>.</li>
          <li>Use <b>View/Print</b> to open the label and print it.</li>
        </ol>
      </div>

      <div
        style={{
          marginTop: 16,
          border: "1px solid #e5e5e5",
          borderRadius: 14,
          padding: 16,
          background: "#fff",
        }}
      >
        <h2 style={{ fontSize: 16, margin: "0 0 10px 0" }}>Daily labels</h2>
        <p style={{ marginTop: 0, color: "#555" }}>
          View all labels created on a specific day, cancel vouchers, refresh the list, and print a PDF list.
        </p>

        <s-link
          href="/app/vouchers"
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
          Open Daily Labels
        </s-link>
      </div>
    </div>
  );
}

