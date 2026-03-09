import { useMemo } from "react";
import { useLocation } from "react-router";

export default function AppHome() {
  const location = useLocation();

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

  const cardStyle = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 280,
    padding: "28px 24px",
    borderRadius: 20,
    background: "#111",
    color: "#fff",
    textDecoration: "none",
    textAlign: "center",
    boxShadow: "0 6px 18px rgba(0,0,0,0.10)",
  };

  const logoWrapStyle = {
    width: "100%",
    height: 140,
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
    fontSize: 20,
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
          gridTemplateColumns: "1fr 1fr",
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

        <s-link href={vouchersHref} style={cardStyle}>
          <div style={logoWrapStyle}>
            <img
              src="/easymail-logo.png"
              alt="EasyMail"
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
            <div style={labelStyle}>EasyMail Daily Labels</div>
          </div>
        </s-link>
      </div>
    </div>
  );
}
