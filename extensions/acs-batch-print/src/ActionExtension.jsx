import { render } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

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
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
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

function safeStr(value) {
  return String(value ?? "").trim();
}

function clampPieces(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(5, Math.floor(parsed)));
}

function decodeBatchResults(value) {
  if (!value) return null;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function Extension() {
  const { data } = shopify;
  const selected = Array.isArray(data?.selected) ? data.selected : [];
  const selectedIds = selected.map((item) => item.id).filter(Boolean);
  const today = useMemo(() => todayLocalYMD(), []);

  const [orders, setOrders] = useState(() =>
    selected.map((item) => ({
      orderId: item.id,
      orderName: safeStr(item.name) || "Order",
      customerName: "",
      lineItems: [],
      total: "",
      currencyCode: "EUR",
      codEnabled: false,
      codAmount: "",
      pieces: "1",
      pickupDate: today,
    })),
  );
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [loadingBatch, setLoadingBatch] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [batchError, setBatchError] = useState("");
  const [batchResults, setBatchResults] = useState(null);
  const [printSource, setPrintSource] = useState("");
  const [ordersExpanded, setOrdersExpanded] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [employeesLoading, setEmployeesLoading] = useState(true);
  const [employeesError, setEmployeesError] = useState("");
  const [employeeId, setEmployeeId] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadEmployees() {
      setEmployeesLoading(true);
      setEmployeesError("");
      try {
        const response = await fetch("/api/employees");
        const payload = await response.json();
        if (!response.ok || !payload?.success) {
          throw new Error(payload?.message || "Could not load employees.");
        }
        if (!cancelled) {
          setEmployees(
            Array.isArray(payload.employees) ? payload.employees : [],
          );
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
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadSelectedOrders() {
      if (!selectedIds.length) return;
      setLoadingOrders(true);
      setLoadError("");

      try {
        const response = await fetch("shopify:admin/api/graphql.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `#graphql
              query SelectedAcsBatchOrders($ids: [ID!]!) {
                nodes(ids: $ids) {
                  ... on Order {
                    id
                    name
                    currentTotalPriceSet { shopMoney { amount currencyCode } }
                    customer { firstName lastName }
                    shippingAddress { name }
                    tags
                    lineItems(first: 50) {
                      nodes { title variantTitle quantity }
                    }
                  }
                }
              }
            `,
            variables: { ids: selectedIds },
          }),
        });

        const payload = await response.json();
        if (!response.ok || payload?.errors?.length) {
          throw new Error(
            payload?.errors?.map((error) => error.message).join(" | ") ||
              "Could not load order details.",
          );
        }

        const byId = new Map(
          (payload?.data?.nodes || [])
            .filter(Boolean)
            .map((order) => [order.id, order]),
        );
        if (cancelled) return;

        setOrders((current) =>
          current.map((row) => {
            const order = byId.get(row.orderId);
            if (!order) return row;

            const shippingName = safeStr(order.shippingAddress?.name);
            const customerName = [
              order.customer?.firstName,
              order.customer?.lastName,
            ]
              .map(safeStr)
              .filter(Boolean)
              .join(" ");

            return {
              ...row,
              orderName: safeStr(order.name) || row.orderName,
              customerName:
                shippingName || customerName || "Customer not listed",
              lineItems: (order.lineItems?.nodes || []).map((item) => ({
                title: safeStr(item.title),
                variantTitle: safeStr(item.variantTitle),
                quantity: Number(item.quantity) || 0,
              })),
              total: safeStr(order.currentTotalPriceSet?.shopMoney?.amount),
              currencyCode: safeStr(
                order.currentTotalPriceSet?.shopMoney?.currencyCode,
              ),
              codEnabled: (order.tags || []).includes("COD"),
              codAmount: safeStr(order.currentTotalPriceSet?.shopMoney?.amount),
            };
          }),
        );
      } catch (error) {
        if (!cancelled)
          setLoadError(error?.message || "Could not load order details.");
      } finally {
        if (!cancelled) setLoadingOrders(false);
      }
    }

    loadSelectedOrders();
    return () => {
      cancelled = true;
    };
  }, [selectedIds.join("|")]);

  const readChecked = useCallback((event) => {
    const target = event?.target;
    if (target && typeof target.checked === "boolean") return target.checked;
    if (typeof event?.detail?.checked === "boolean")
      return event.detail.checked;
    if (typeof event?.detail?.value === "boolean") return event.detail.value;
    return Boolean(event?.detail?.value);
  }, []);

  const updateOrder = useCallback((orderId, updates) => {
    setOrders((current) =>
      current.map((order) =>
        order.orderId === orderId ? { ...order, ...updates } : order,
      ),
    );
    setBatchResults(null);
    setBatchError("");
    setPrintSource("");
  }, []);

  const generateBatch = useCallback(async () => {
    setLoadingBatch(true);
    setBatchError("");
    setBatchResults(null);
    setPrintSource("");

    try {
      const response = await fetch("/api/acs-batch-merge-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId,
          orders: orders.map((order) => ({
            orderId: order.orderId,
            orderName: order.orderName,
            pieces: String(clampPieces(order.pieces)),
            pickupDate: order.pickupDate,
            cod: order.codEnabled,
            codAmount: order.codEnabled ? order.codAmount : "",
          })),
        }),
      });

      const contentType = response.headers.get("Content-Type") || "";
      if (contentType.includes("application/pdf")) {
        const results = decodeBatchResults(
          response.headers.get("X-ACS-Batch-Results"),
        );
        const vouchers = (results?.successes || [])
          .map(
            (order) =>
              order.printVoucherNumber || order.voucherNumbers?.[0] || "",
          )
          .filter(Boolean);
        if (!vouchers.length) {
          throw new Error(
            "The labels were generated, but no voucher numbers were returned for the preview.",
          );
        }
        const params = new URLSearchParams({
          vouchers: JSON.stringify(vouchers),
        });
        setBatchResults(results);
        setPrintSource(`/api/acs-batch-print-document?${params.toString()}`);
      } else {
        const payload = await response.json().catch(() => null);
        const results = payload?.results || null;
        if (results) setBatchResults(results);
        if (!response.ok || !payload?.success) {
          const firstError = results?.errors?.[0]?.message;
          setBatchError(
            firstError || payload?.message || "No labels could be generated.",
          );
        }
      }
    } catch (error) {
      setBatchError(error?.message || "Unexpected ACS batch error.");
    } finally {
      setLoadingBatch(false);
    }
  }, [orders, employeeId]);

  const lineSummary = (lineItems) =>
    lineItems.length
      ? lineItems
          .map((item) => {
            const variant =
              item.variantTitle && item.variantTitle !== "Default Title"
                ? ` — ${item.variantTitle}`
                : "";
            return `${item.title}${variant} × ${item.quantity}`;
          })
          .join(", ")
      : "Order details unavailable";

  const commonPickupDate =
    orders.length &&
    orders.every((order) => order.pickupDate === orders[0].pickupDate)
      ? orders[0].pickupDate
      : "";

  const updateAllPickupDates = useCallback((pickupDate) => {
    setOrders((current) => current.map((order) => ({ ...order, pickupDate })));
    setBatchResults(null);
    setBatchError("");
    setPrintSource("");
  }, []);

  return (
    <s-admin-print-action
      heading="Print ACS Labels"
      src={printSource || undefined}
    >
      <s-box paddingBlockStart="small">
        <s-banner tone="info">
          <s-text>Orders selected: {orders.length}</s-text>
          <s-box paddingBlockStart="small">
            <s-text>
              Review the orders and generate the labels. The print preview will
              load the ACS PDF when it is ready.
            </s-text>
          </s-box>
        </s-banner>
      </s-box>

      <s-box paddingBlockStart="small">
        <s-date-field
          label="Pickup date for all orders"
          value={commonPickupDate}
          onChange={(event) => updateAllPickupDates(readDateFieldValue(event))}
          onInput={(event) => updateAllPickupDates(readDateFieldValue(event))}
          placeholder={
            commonPickupDate ? "YYYY-MM-DD" : "Orders have different dates"
          }
          disabled={!orders.length || loadingOrders || loadingBatch}
          error={
            commonPickupDate && !isValidDateYMD(commonPickupDate)
              ? "Enter a real date in YYYY-MM-DD format."
              : undefined
          }
          details="Changing this date updates every selected order. You can still adjust individual orders below."
        ></s-date-field>
      </s-box>

      <s-box paddingBlockStart="small">
        <s-select
          label="Name"
          value={employeeId}
          required
          disabled={employeesLoading || loadingBatch || !employees.length}
          onChange={(event) => {
            setEmployeeId(event.currentTarget.value);
            setBatchResults(null);
            setBatchError("");
            setPrintSource("");
          }}
        >
          <s-option value="">Select employee</s-option>
          {employees.map((employee) => (
            <s-option key={employee.id} value={employee.id}>
              {employee.name}
            </s-option>
          ))}
        </s-select>
      </s-box>

      {employeesError ? (
        <s-box paddingBlockStart="small">
          <s-banner tone="critical">
            <s-text>{employeesError}</s-text>
          </s-banner>
        </s-box>
      ) : null}

      {!employeesLoading && !employeesError && employees.length === 0 ? (
        <s-box paddingBlockStart="small">
          <s-banner tone="info">
            <s-text>
              Add at least one employee in the app page “Dipendenti” to
              continue.
            </s-text>
          </s-banner>
        </s-box>
      ) : null}

      <s-box paddingBlockStart="small">
        <s-button
          onClick={generateBatch}
          disabled={
            !orders.length ||
            !employeeId ||
            employeesLoading ||
            Boolean(employeesError) ||
            loadingOrders ||
            loadingBatch ||
            Boolean(loadError) ||
            !orders.every((order) => isValidDateYMD(order.pickupDate))
          }
        >
          {loadingBatch ? "Generating labels…" : "Generate ACS labels"}
        </s-button>
      </s-box>

      {batchResults?.errors?.length ? (
        <s-box paddingBlockStart="small">
          <s-banner tone="warning">
            <s-text>
              Could not generate labels for {batchResults.errors.length}{" "}
              order(s):
            </s-text>
            {batchResults.errors.map((item) => (
              <s-box key={item.orderId} paddingBlockStart="xsmall">
                <s-text>
                  {item.orderName}: {item.message}
                </s-text>
              </s-box>
            ))}
          </s-banner>
        </s-box>
      ) : null}

      {batchResults?.tagWarnings?.length ? (
        <s-box paddingBlockStart="small">
          <s-banner tone="warning">
            <s-text>Some employee tags could not be added:</s-text>
            {batchResults.tagWarnings.map((item) => (
              <s-box key={item.orderId} paddingBlockStart="xsmall">
                <s-text>
                  {item.orderName}: {item.message}
                </s-text>
              </s-box>
            ))}
          </s-banner>
        </s-box>
      ) : null}

      {batchError ? (
        <s-box paddingBlockStart="small">
          <s-banner tone="critical">
            <s-text>{batchError}</s-text>
          </s-banner>
        </s-box>
      ) : null}

      {batchResults?.successes?.length ? (
        <s-box paddingBlockStart="small">
          <s-banner tone="success">
            <s-text>
              {batchResults.successes.length} order(s) ready to print.
            </s-text>
          </s-banner>
        </s-box>
      ) : null}

      {loadError ? (
        <s-box paddingBlockStart="small">
          <s-banner tone="critical">
            <s-text>{loadError}</s-text>
          </s-banner>
        </s-box>
      ) : null}

      {loadingOrders ? (
        <s-box paddingBlockStart="small">
          <s-text>Loading selected order details…</s-text>
        </s-box>
      ) : null}

      <s-box paddingBlockStart="small">
        <s-button onClick={() => setOrdersExpanded((expanded) => !expanded)}>
          {ordersExpanded
            ? "⌃ Hide selected orders"
            : `⌄ Show ${orders.length} selected orders`}
        </s-button>
      </s-box>

      {ordersExpanded ? (
        <s-box paddingBlockStart="small">
          {orders.map((order) => (
            <s-box key={order.orderId} paddingBlockStart="small">
              <s-banner tone="info">
                <s-text>
                  {order.orderName} —{" "}
                  {order.customerName || "Loading customer…"}
                </s-text>
                <s-box paddingBlockStart="xsmall">
                  <s-text tone="subdued">
                    {lineSummary(order.lineItems)}
                    {order.total
                      ? ` • ${order.total} ${order.currencyCode || ""}`
                      : ""}
                  </s-text>
                </s-box>
                <s-box paddingBlockStart="xsmall">
                  <s-inline-stack gap="base" blockAlignment="center">
                    <s-checkbox
                      label={
                        order.codEnabled ? "COD — enabled" : "COD — disabled"
                      }
                      checked={Boolean(order.codEnabled)}
                      onChange={(event) =>
                        updateOrder(order.orderId, {
                          codEnabled: readChecked(event),
                          codAmount: order.codAmount || order.total,
                        })
                      }
                    />
                    <s-text tone="subdued">
                      {order.codEnabled ? "COD" : "Non-COD"}
                    </s-text>
                  </s-inline-stack>
                </s-box>
                {order.codEnabled ? (
                  <s-box paddingBlockStart="xsmall">
                    <s-text-field
                      label="COD amount"
                      suffix={order.currencyCode || "EUR"}
                      details="Prefilled with the order total; edit it if you need a different amount."
                      value={order.codAmount}
                      onInput={(event) =>
                        updateOrder(order.orderId, {
                          codAmount: event.target.value,
                        })
                      }
                      placeholder="Order total"
                    />
                  </s-box>
                ) : null}
                <s-inline-stack gap="base">
                  <s-text>Pieces: {clampPieces(order.pieces)}</s-text>
                  <s-button
                    onClick={() =>
                      updateOrder(order.orderId, {
                        pieces: String(clampPieces(Number(order.pieces) - 1)),
                      })
                    }
                    disabled={loadingBatch || Number(order.pieces) <= 1}
                  >
                    −
                  </s-button>
                  <s-button
                    onClick={() =>
                      updateOrder(order.orderId, {
                        pieces: String(clampPieces(Number(order.pieces) + 1)),
                      })
                    }
                    disabled={loadingBatch || Number(order.pieces) >= 5}
                  >
                    +
                  </s-button>
                </s-inline-stack>
              </s-banner>
              <s-box paddingBlockStart="small">
                <s-date-field
                  label={`Pickup date — ↑ ${order.orderName}`}
                  value={order.pickupDate}
                  onChange={(event) =>
                    updateOrder(order.orderId, {
                      pickupDate: readDateFieldValue(event),
                    })
                  }
                  onInput={(event) =>
                    updateOrder(order.orderId, {
                      pickupDate: readDateFieldValue(event),
                    })
                  }
                  error={
                    !isValidDateYMD(order.pickupDate)
                      ? "Enter a real date in YYYY-MM-DD format."
                      : undefined
                  }
                  placeholder="YYYY-MM-DD"
                ></s-date-field>
              </s-box>
            </s-box>
          ))}
          {!orders.length ? (
            <s-box paddingBlockStart="small">
              <s-text>No selected orders.</s-text>
            </s-box>
          ) : null}
        </s-box>
      ) : null}
    </s-admin-print-action>
  );
}
