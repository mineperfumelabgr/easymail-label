import { render } from "preact";
import { useCallback, useMemo, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const { data } = shopify;
  const orderId = data?.selected?.[0]?.id || null;

  const [isLoading, setIsLoading] = useState(false);
  const [pieces, setPieces] = useState("1");

  const [mode, setMode] = useState("idle"); // idle | exists | generated
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const [voucherNumber, setVoucherNumber] = useState("");
  const [labelUrl, setLabelUrl] = useState("");
  const [labels, setLabels] = useState([]); // [{ number, url }]
  const [cancelNumber, setCancelNumber] = useState("");

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
          `&pieces=${encodeURIComponent(pcs)}`;

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
    [orderId, pieces, clampPieces, fetchJson, normalizeLabels]
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

      {/* Pieces selector */}
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

      {/* Exists */}
      {mode === "exists" && (
        <s-box paddingBlockStart="small">
          <s-banner tone="warning">
            <s-text>{message}</s-text>

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

      {/* Cancel voucher (manual) */}
      <s-box paddingBlockStart="small">
        <s-banner tone="warning">
          <s-text>Cancel voucher (manual):</s-text>

          <s-box paddingBlockStart="small">
            <s-text-field
              value={cancelNumber}
              onInput={(e) => setCancelNumber(e.target.value)}
              placeholder="Enter voucher number (ShipmentNumber)"
            />
          </s-box>

          <s-box paddingBlockStart="small">
            <s-inline-stack gap="base">
              <s-button
                disabled={isLoading || !String(cancelNumber).trim()}
                onClick={async () => {
                  setIsLoading(true);
                  setErrorMessage("");
                  setMessage("");

                  try {
                    const n = String(cancelNumber).trim();
                    const url = `/api/easymail-cancel-voucher?number=${encodeURIComponent(n)}`;

                    // usa la tua helper fetchJson (già presente nel file)
                    const j = await fetchJson(url);

                    // j.success già true, quindi guardiamo result/canceled
if (j.result && (j.canceled === true || j.canceled === "true")) {
  setMessage(`✅ Voucher ${n} successfully canceled.`);
  setCancelNumber("");
} else {
  throw new Error(j.message || `Cancel failed for voucher: ${n}`);
}

                  } catch (e) {
                    setErrorMessage(e?.message || "Cancel error.");
                  } finally {
                    setIsLoading(false);
                  }
                }}
              >
                Cancel now
              </s-button>

              <s-button
                disabled={isLoading}
                onClick={() => {
                  setCancelNumber("");
                  setErrorMessage("");
                  setMessage("");
                }}
              >
                Clear
              </s-button>
            </s-inline-stack>
          </s-box>

          <s-box paddingBlockStart="xsmall">
            <s-text>
              Note: cancellation is possible only if the shipment has not been processed by the courier.
            </s-text>
          </s-box>
        </s-banner>
      </s-box>


      {/* CSV */}
      <s-box paddingBlockStart="small">
        <s-banner tone="info">
          <s-text>Daily export:</s-text>
          <s-box paddingBlockStart="small">
            <s-button href={csvHref} disabled={isLoading}>
              Download today’s CSV
            </s-button>
          </s-box>
        </s-banner>
      </s-box>


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

