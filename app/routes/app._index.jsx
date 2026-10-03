import { useMemo } from "react";
import { useLocation } from "react-router";

export default function AppHome() {
  const location = useLocation();

  const acsVouchersHref = useMemo(() => {
    const qs = location.search || "";
    const base = "/app/acs-vouchers";
    return qs ? `${base}${qs}` : base;
  }, [location.search]);

  const cardStyle = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 170,
    padding: "24px",
    borderRadius: 12,
    background: "#fff",
    color: "#202223",
    textDecoration: "none",
    textAlign: "center",
    boxShadow: "0 1px 4px rgba(0,0,0,0.10)",
    border: "1px solid #e1e3e5",
  };

  const logoWrapStyle = {
    width: "100%",
    height: 65,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const labelWrapStyle = {
    width: "100%",
    minHeight: 56,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 18,
  };

  const labelStyle = {
    fontSize: 18,
    fontWeight: 700,
    lineHeight: 1.2,
  };

  return (
    <div
      style={{
        maxWidth: 980,
        margin: "40px auto",
        padding: 20,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 26, marginBottom: 8 }}>Shipping Labels</h1>

      <p style={{ marginTop: 0, color: "#555", marginBottom: 30, fontSize: 15 }}>
        Manage your courier labels directly from Shopify Admin.
      </p>

      <div
        style={{
          display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 22,
        }}
      >
        <s-link href={acsVouchersHref} style={cardStyle}>
          <div style={logoWrapStyle}>
            <img
              src="/acs-logo.png"
              alt="ACS"
              style={{
                maxHeight: 90,
                maxWidth: "80%",
                width: "auto",
                objectFit: "contain",
                display: "block",
              }}
            />
          </div>

          <div style={labelWrapStyle}>
            <div style={labelStyle}>ACS Daily Labels</div>
          </div>
        </s-link>
        {[["/app/acs-tracking", "ACS Tracking", "Review delivery status, returns and exceptions."], ["/app/acs-tracking-settings", "ACS Tag Settings", "Choose Shopify tags for each ACS shipment status."], ["/app/acs-custom-shipment", "Custom ACS Shipment", "Create an ACS label without a Shopify order."]].map(([href, title, description]) => <s-link key={href} href={`${href}${location.search || ""}`} style={{ ...cardStyle, alignItems: "flex-start", textAlign: "left" }}><div style={{ ...labelWrapStyle, justifyContent: "flex-start", minHeight: 30, marginTop: 0 }}><div style={labelStyle}>{title}</div></div><p style={{ color: "#616161", lineHeight: 1.5 }}>{description}</p></s-link>)}
      </div>
    </div>
  );
}
