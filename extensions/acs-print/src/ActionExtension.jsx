import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

export default async () => {
  render(<Extension />, document.body);
};

function todayLocalYMD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isValidDateYMD(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31, leapYear ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31,
  ];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function readDateFieldValue(event) {
  return String(
    event?.currentTarget?.value ??
      event?.target?.value ??
      event?.detail?.value ??
      "",
  );
}

function Extension() {
  const { data } = shopify;
  const orderId = data?.selected?.[0]?.id || null;

  const [isLoading, setIsLoading] = useState(false);
  const [pieces, setPieces] = useState("1");
  const [pickupDate, setPickupDate] = useState(todayLocalYMD());
  const [employees, setEmployees] = useState([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [employeesError, setEmployeesError] = useState("");
  const [employeeId, setEmployeeId] = useState("");

  const [codEnabled, setCodEnabled] = useState(false);
  const [codAutoHint, setCodAutoHint] = useState("");
  const [codAmount, setCodAmount] = useState("");
  const [codCurrencyCode, setCodCurrencyCode] = useState("EUR");

  const [mode, setMode] = useState("idle"); // idle | exists | generated
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [employeeTagWarning, setEmployeeTagWarning] = useState("");

  const [voucherNumber, setVoucherNumber] = useState("");
  const [labelUrl, setLabelUrl] = useState("");
  const [labels, setLabels] = useState([]);

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

  const readChecked = useCallback((e) => {
    const t = e?.target;
    if (t && typeof t.checked === "boolean") return t.checked;
    if (typeof e?.detail?.checked === "boolean") return e.detail.checked;
    if (typeof e?.detail?.value === "boolean") return e.detail.value;
    return Boolean(e?.detail?.value);
  }, []);

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

        if (!cancelled) {
          const total = Number(j?.orderTotal);
          setCodAmount(Number.isFinite(total) && total > 0 ? total.toFixed(2) : "");
          setCodCurrencyCode(String(j?.currencyCode || "EUR"));
        }
      } catch {
        // ignore
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [orderId, fetchJson]);

  useEffect(() => {
    let cancelled = false;

    async function loadEmployees() {
      setEmployeesLoading(true);
      setEmployeesError("");
      try {
        const json = await fetchJson("/api/employees");
        if (!cancelled) {
          setEmployees(Array.isArray(json.employees) ? json.employees : []);
        }
      } catch (error) {
        if (!cancelled) {
          setEmployeesError(error?.message || "Could not load employees.");
        }
      } finally {
        if (!cancelled) setEmployeesLoading(false);
      }
    }

    loadEmployees();
    return () => {
      cancelled = true;
    };
  }, [fetchJson]);

  const runGenerate = useCallback(
    async ({ forceNew }) => {
      setIsLoading(true);
      setErrorMessage("");
      setEmployeeTagWarning("");
      setMessage("");

      try {
        if (!orderId) throw new Error("Order ID is not available.");
        if (!employeeId) throw new Error("Select an employee before generating the label.");
        if (!isValidDateYMD(pickupDate)) throw new Error("Enter a valid pickup date.");

        const pcs = clampPieces(pieces);

        let url =
          `/api/acs-create-label?orderId=${encodeURIComponent(orderId)}` +
          `&pieces=${encodeURIComponent(pcs)}` +
          `&cod=${encodeURIComponent(codEnabled ? "1" : "0")}` +
          `&pickupDate=${encodeURIComponent(pickupDate)}` +
          `&employeeId=${encodeURIComponent(employeeId)}` +
          `&contentTypeId=${encodeURIComponent("7")}`;

        if (codEnabled && codAmount.trim()) {
          url += `&codAmount=${encodeURIComponent(codAmount.trim())}`;
        }

        if (forceNew) url += `&forceNew=1`;

        const json = await fetchJson(url);
        setEmployeeTagWarning(String(json.employeeTagWarning || ""));

        const newLabels = normalizeLabels(json);
        setLabels(newLabels);

        // An existing voucher carries its original pickup date. Keep the date
        // currently selected in the form so "Generate new" uses that date.
        if (json.pickupDate && !json.exists) {
          setPickupDate(String(json.pickupDate));
        }

        if (json.exists) {
          setMode("exists");
          setVoucherNumber(String(json.voucherNumber || ""));
          setLabelUrl(String(json.labelUrl || ""));
          setMessage(
            json.message ||
              `An ACS label already exists for this order. Voucher: ${json.voucherNumber || ""}`,
          );
          return;
        }

        setMode("generated");
        setVoucherNumber(String(json.voucherNumber || ""));
        setLabelUrl(String(json.labelUrl || ""));
        setMessage(json.message || `ACS label generated. Voucher: ${json.voucherNumber || ""}`);
      } catch (e) {
        setErrorMessage(e?.message || "Unexpected ACS error.");
      } finally {
        setIsLoading(false);
      }
    },
    [orderId, pieces, codEnabled, codAmount, pickupDate, employeeId, clampPieces, fetchJson, normalizeLabels],
  );

  return (
    <s-admin-action heading="ACS Labels">
      <s-box paddingBlockStart="small">
        <s-date-field
          label="Pickup date"
          value={pickupDate}
          onChange={(event) => setPickupDate(readDateFieldValue(event))}
          onInput={(event) => setPickupDate(readDateFieldValue(event))}
          error={pickupDate && !isValidDateYMD(pickupDate) ? "Enter a real date in YYYY-MM-DD format." : undefined}
          details="This date will be used later for the ACS pickup list."
        ></s-date-field>
      </s-box>

      <s-box paddingBlockStart="small">
        <s-select
          label="Name"
          value={employeeId}
          required
          disabled={employeesLoading || isLoading || !employees.length}
          onChange={(event) => setEmployeeId(event.currentTarget.value)}
        >
          <s-option value="">Select employee</s-option>
          {employees.map((employee) => (
            <s-option key={employee.id} value={employee.id}>
              {employee.name}
            </s-option>
          ))}
        </s-select>
        {employeesError ? (
          <s-box paddingBlockStart="xsmall">
            <s-banner tone="critical"><s-text>{employeesError}</s-text></s-banner>
          </s-box>
        ) : !employeesLoading && !employees.length ? (
          <s-box paddingBlockStart="xsmall">
            <s-text tone="subdued">Add employees in the Dipendenti section before generating a label.</s-text>
          </s-box>
        ) : null}
      </s-box>

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

      <s-box paddingBlockStart="small">
        <s-banner tone="info">
          <s-text>COD (Cash on Delivery):</s-text>

          <s-box paddingBlockStart="small">
            <s-checkbox
              label="COD"
              checked={codEnabled}
              disabled={isLoading}
              onChange={(e) => setCodEnabled(readChecked(e))}
            />
          </s-box>

          {codEnabled ? (
            <s-box paddingBlockStart="small">
              <s-text-field
                label="COD amount"
                suffix={codCurrencyCode}
                details="Prefilled with the order total; edit it when you need a different COD amount."
                value={codAmount}
                onInput={(e) => setCodAmount(e.target.value)}
                placeholder="Order total"
                disabled={isLoading}
              />
            </s-box>
          ) : null}

          {codAutoHint ? (
            <s-box paddingBlockStart="xsmall">
              <s-text tone="subdued">{codAutoHint}</s-text>
            </s-box>
          ) : null}

          <s-box paddingBlockStart="xsmall">
            <s-text tone="subdued">
              For Cyprus, the content type is currently sent automatically as COSMETICS.
            </s-text>
          </s-box>
        </s-banner>
      </s-box>

      {mode === "exists" && (
        <s-box paddingBlockStart="small">
          <s-banner tone="warning">
            <s-text>{message}</s-text>

            {voucherNumber ? (
              <s-box paddingBlockStart="xsmall">
                <s-text>ACS voucher: {voucherNumber}</s-text>
              </s-box>
            ) : null}

            <s-box paddingBlockStart="xsmall">
              <s-text>Pickup date: {pickupDate}</s-text>
            </s-box>

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
                      View/Print ACS label #{idx + 1}
                    </s-button>
                  ))
                ) : (
                  <s-button
                    href={addInlineParam(labelUrl)}
                    target="_blank"
                    rel="noopener"
                    disabled={!labelUrl || isLoading}
                  >
                    View/Print existing ACS label
                  </s-button>
                )}

                <s-button onClick={() => runGenerate({ forceNew: true })} disabled={isLoading || !employeeId || !isValidDateYMD(pickupDate)}>
                  Generate new ACS label (keep old)
                </s-button>
              </s-inline-stack>
            </s-box>
          </s-banner>
        </s-box>
      )}

      {mode === "generated" && (
        <s-box paddingBlockStart="small">
          <s-banner tone="success">
            <s-text>{message}</s-text>

            {voucherNumber ? (
              <s-box paddingBlockStart="xsmall">
                <s-text>ACS voucher: {voucherNumber}</s-text>
              </s-box>
            ) : null}

            <s-box paddingBlockStart="xsmall">
              <s-text>Pickup date: {pickupDate}</s-text>
            </s-box>

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
                      View/Print ACS label #{idx + 1}
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
                  View/Print ACS label
                </s-button>
              )}
            </s-box>
          </s-banner>
        </s-box>
      )}
      {employeeTagWarning && (
        <s-box paddingBlockStart="small">
          <s-banner tone="warning"><s-text>{employeeTagWarning}</s-text></s-banner>
        </s-box>
      )}
{mode === "idle" && (
  <s-box paddingBlockStart="large">
    <s-button
      onClick={() => runGenerate({ forceNew: false })}
      disabled={isLoading || employeesLoading || !employeeId || !isValidDateYMD(pickupDate)}
    >
      {isLoading ? "Generating..." : "Generate ACS label"}
    </s-button>
  </s-box>
)}
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
