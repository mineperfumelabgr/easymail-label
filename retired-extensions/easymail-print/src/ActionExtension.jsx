import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { data } = shopify;
  const orderId = data?.selected?.[0]?.id || null;

  const [isLoading, setIsLoading] = useState(false);
  const [pieces, setPieces] = useState("1");

  // COD override (UI)
  const [codEnabled, setCodEnabled] = useState(false);
  const [codAutoHint, setCodAutoHint] = useState("");

  const [mode, setMode] = useState("idle"); // idle | exists | generated
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const [voucherNumber, setVoucherNumber] = useState("");
  const [labelUrl, setLabelUrl] = useState("");
  const [labels, setLabels] = useState([]); // [{ number, url }]

  const clampPieces = useCallback((val) => {
    const n = Number(val);
    if (!Number.isFinite(n)) return "1";
    return String(Math.max(1, Math.min(5, Math.floor(n))));
  }, []);

  const fetchJson = useCallback(async (url) => {
    const res = await fetch(url);
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Server did not return JSON. Response: ${text.slice(0, 300)}`);
    }

    if (!res.ok || !json?.success) {
      throw new Error(json?.message || "Request failed.");
    }
    return json;
  }, []);

  const normalizeLabels = useCallback((json) => {
    const arr = Array.isArray(json?.labels) ? json.labels : [];
    const cleaned = arr
      .map((x) => ({
        number: String(x?.number || ""),
        url: String(x?.url || ""),
      }))
      .filter((x) => x.number && x.url);

    if (cleaned.length) return cleaned;

    const n = String(json?.voucherNumber || "");
    const u = String(json?.labelUrl || "");
    if (n && u) return [{ number: n, url: u }];
    return [];
  }, []);

  const addInlineParam = useCallback((u) => {
    if (!u) return "";
    return u.includes("?") ? `${u}&inline=1` : `${u}?inline=1`;
  }, []);

  // Read checkbox value from Shopify web component events (various shapes)
  const readChecked = useCallback((e) => {
    const t = e?.target;
    if (t && typeof t.checked === "boolean") return t.checked;
    if (typeof e?.detail?.checked === "boolean") return e.detail.checked;
    if (typeof e?.detail?.value === "boolean") return e.detail.value;
    return Boolean(e?.detail?.value);
  }, []);

  // Best-effort COD auto-detect (does NOT create label)
  // Uses your existing endpoint; if it doesn't provide COD info, we stay silent.
  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!orderId) return;

      try {
        const url = `/api/easymail-label-status?orderId=${encodeURIComponent(orderId)}`;
        const j = await fetchJson(url);

        const tags = Array.isArray(j?.tags)
          ? j.tags
          : Array.isArray(j?.orderTags)
          ? j.orderTags
          : null;

        const detected =
          (typeof j?.isCOD === "boolean" ? j.isCOD : null) ??
          (typeof j?.isCod === "boolean" ? j.isCod : null) ??
          (typeof j?.cod === "boolean" ? j.cod : null) ??
          (typeof j?.orderCod === "boolean" ? j.orderCod : null) ??
          (tags ? tags.map(String).includes("COD") : null);

        if (!cancelled && typeof detected === "boolean") {
          setCodEnabled(detected);
          setCodAutoHint(detected ? "Auto-detected: COD order" : "");
        }
      } catch {
        // ignore (no COD auto info available)
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [orderId, fetchJson]);

  const runGenerate = useCallback(
    async ({ forceNew }) => {
      setIsLoading(true);
      setErrorMessage("");
      setMessage("");

      try {
        if (!orderId) throw new Error("Order ID is not available.");

        const pcs = clampPieces(pieces);

        let url =
          `/api/easymail-create-label?orderId=${encodeURIComponent(orderId)}` +
          `&pieces=${encodeURIComponent(pcs)}` +
          `&cod=${encodeURIComponent(codEnabled ? "1" : "0")}`;

        if (forceNew) url += `&forceNew=1`;

        const json = await fetchJson(url);

        const newLabels = normalizeLabels(json);
        setLabels(newLabels);

        if (json.exists) {
          setMode("exists");
          setVoucherNumber(String(json.voucherNumber || ""));
          setLabelUrl(String(json.labelUrl || ""));
          setMessage(
            json.message ||
              `A label already exists for this order. Voucher: ${json.voucherNumber || ""}`
          );
          return;
        }

        setMode("generated");
        setVoucherNumber(String(json.voucherNumber || ""));
        setLabelUrl(String(json.labelUrl || ""));
        setMessage(json.message || `Label generated. Voucher: ${json.voucherNumber || ""}`);
      } catch (e) {
        setErrorMessage(e?.message || "Unexpected error.");
      } finally {
        setIsLoading(false);
      }
    },
    [orderId, pieces, codEnabled, clampPieces, fetchJson, normalizeLabels]
  );

  const hidePrimaryGenerate = mode === "exists";

  return (
    <s-admin-action heading="EasyMail Labels">
      {!hidePrimaryGenerate && (
        <s-button
          slot="primaryAction"
          onClick={() => runGenerate({ forceNew: false })}
          disabled={isLoading}
        >
          {isLoading ? "..." : "Generate EasyMail label"}
        </s-button>
      )}

      {/* Pieces selector (BIG / SAFE like original) */}
      <s-box paddingBlockStart="small">
        <s-banner tone="info">
          <s-text>Packages (pieces) — choose 1 to 5:</s-text>

          <s-box paddingBlockStart="small">
            <s-text-field
              value={pieces}
              onInput={(e) => setPieces(clampPieces(e.target.value))}
              placeholder="1"
            />
          </s-box>

          <s-box paddingBlockStart="xsmall">
            <s-inline-stack gap="base">
              <s-button
                onClick={() => setPieces((p) => clampPieces(Number(p) - 1))}
                disabled={isLoading}
              >
                −
              </s-button>
              <s-button
                onClick={() => setPieces((p) => clampPieces(Number(p) + 1))}
                disabled={isLoading}
              >
                +
              </s-button>
            </s-inline-stack>
          </s-box>
        </s-banner>
      </s-box>

      {/* COD override (BIG / SAFE) */}
      <s-box paddingBlockStart="small">
        <s-banner tone="info">
          <s-text>COD (Cash on Delivery):</s-text>

          <s-box paddingBlockStart="small">
            {/* IMPORTANT: use label= so text always appears */}
            <s-checkbox
              label="COD"
              checked={codEnabled}
              disabled={isLoading}
              onChange={(e) => setCodEnabled(readChecked(e))}
            />
          </s-box>

          {codAutoHint ? (
            <s-box paddingBlockStart="xsmall">
              <s-text tone="subdued">{codAutoHint}</s-text>
            </s-box>
          ) : null}

          <s-box paddingBlockStart="xsmall">
            <s-text tone="subdued">
              Tip: you can toggle this to force COD on/off for this label generation.
            </s-text>
          </s-box>
        </s-banner>
      </s-box>

      {/* Exists */}
      {mode === "exists" && (
        <s-box paddingBlockStart="small">
          <s-banner tone="warning">
            <s-text>{message}</s-text>

            {voucherNumber ? (
              <s-box paddingBlockStart="xsmall">
                <s-text>Voucher: {voucherNumber}</s-text>
              </s-box>
            ) : null}

            <s-box paddingBlockStart="small">
              <s-inline-stack gap="base">
                {labels.length > 1 ? (
                  labels.map((l, idx) => (
                    <s-button
                      key={l.number}
                      href={addInlineParam(l.url)}
                      target="_blank"
                      rel="noopener"
                      disabled={isLoading}
                    >
                      View/Print label #{idx + 1}
                    </s-button>
                  ))
                ) : (
                  <s-button
                    href={addInlineParam(labelUrl)}
                    target="_blank"
                    rel="noopener"
                    disabled={!labelUrl || isLoading}
                  >
                    View/Print existing label
                  </s-button>
                )}

                {/* Uses CURRENT UI values (pieces + COD) */}
                <s-button onClick={() => runGenerate({ forceNew: true })} disabled={isLoading}>
                  Generate new label (keep old)
                </s-button>
              </s-inline-stack>
            </s-box>
          </s-banner>
        </s-box>
      )}

      {/* Generated */}
      {mode === "generated" && (
        <s-box paddingBlockStart="small">
          <s-banner tone="success">
            <s-text>{message}</s-text>

            {voucherNumber ? (
              <s-box paddingBlockStart="xsmall">
                <s-text>Voucher: {voucherNumber}</s-text>
              </s-box>
            ) : null}

            <s-box paddingBlockStart="small">
              {labels.length > 1 ? (
                <s-inline-stack gap="base">
                  {labels.map((l, idx) => (
                    <s-button
                      key={l.number}
                      href={addInlineParam(l.url)}
                      target="_blank"
                      rel="noopener"
                      disabled={isLoading}
                    >
                      View/Print label #{idx + 1}
                    </s-button>
                  ))}
                </s-inline-stack>
              ) : (
                <s-button
                  href={addInlineParam(labelUrl)}
                  target="_blank"
                  rel="noopener"
                  disabled={!labelUrl || isLoading}
                >
                  View/Print label
                </s-button>
              )}
            </s-box>
          </s-banner>
        </s-box>
      )}

      {/* Errors */}
      {errorMessage && (
        <s-box paddingBlockStart="small">
          <s-banner tone="critical">
            <s-text>{errorMessage}</s-text>
          </s-banner>
        </s-box>
      )}
    </s-admin-action>
  );
}

