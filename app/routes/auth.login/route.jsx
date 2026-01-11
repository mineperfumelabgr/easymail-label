import { useEffect, useMemo, useState } from "react";
import { useActionData, useNavigation, Form, useSearchParams } from "@remix-run/react";

// Login page used when the app is opened outside the embedded context
// or when Shopify can't infer the shop automatically.
// We keep this very simple and user-proof.

export default function Login() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();

  const isSubmitting = navigation.state === "submitting";

  // If Shopify passes shop as a query param, prefill it.
  const initialShop = useMemo(() => {
    const s = (searchParams.get("shop") || "").trim();
    return s;
  }, [searchParams]);

  const [shop, setShop] = useState(initialShop);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (initialShop && !shop) setShop(initialShop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialShop]);

  const normalizeShop = (value) => {
    let s = String(value || "").trim();
    s = s.replace(/^https?:\/\//i, ""); // remove protocol if pasted
    s = s.replace(/\/.*$/g, "");        // remove any path
    return s;
  };

  const validate = (value) => {
    const s = normalizeShop(value);
    if (!s) return "Please enter your Shopify store domain (e.g. mine-perfume-lab-gr.myshopify.com).";
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(s)) {
      return "Invalid shop domain. It must look like: your-store.myshopify.com";
    }
    return "";
  };

  return (
    <div style={{ maxWidth: 520, margin: "40px auto", padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <h1 style={{ fontSize: 24, marginBottom: 6 }}>EasyMail Label</h1>
      <p style={{ marginTop: 0, color: "#555" }}>
        Enter your shop domain to continue.
      </p>

      <Form
        method="post"
        onSubmit={(e) => {
          const err = validate(shop);
          setLocalError(err);
          if (err) e.preventDefault();
        }}
      >
        <label htmlFor="shop" style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>
          Shop domain
        </label>

        <input
          id="shop"
          name="shop"
          value={shop}
          onChange={(e) => {
            setLocalError("");
            setShop(normalizeShop(e.target.value));
          }}
          placeholder="mine-perfume-lab-gr.myshopify.com"
          autoComplete="off"
          spellCheck={false}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #ccc",
            fontSize: 14,
          }}
        />

        <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
          Example: <code>mine-perfume-lab-gr.myshopify.com</code>
        </div>

        {(localError || actionData?.error) && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 10,
              background: "#fdecea",
              border: "1px solid #f5c2c7",
              color: "#842029",
              fontSize: 14,
            }}
          >
            {localError || actionData?.error}
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          style={{
            marginTop: 16,
            width: "100%",
            padding: "10px 12px",
            borderRadius: 12,
            border: "none",
            background: "#111",
            color: "white",
            fontSize: 14,
            cursor: "pointer",
            opacity: isSubmitting ? 0.7 : 1,
          }}
        >
          {isSubmitting ? "Logging in..." : "Log in"}
        </button>
      </Form>

      <div style={{ marginTop: 18, fontSize: 12, color: "#777" }}>
        If you opened the app from Shopify Admin, you normally won&apos;t see this screen.
      </div>
    </div>
  );
}

