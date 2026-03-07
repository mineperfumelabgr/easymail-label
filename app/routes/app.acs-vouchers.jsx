import { useEffect, useState } from "react";

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function addInlineParam(u) {
  if (!u) return "";
  return u.includes("?") ? `${u}&inline=1` : `${u}?inline=1`;
}

export default function AcsDailyLabelsPage() {
  const [date, setDate] = useState(todayYMD());
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [manualDeleting, setManualDeleting] = useState(false);
  const [manualVoucherNo, setManualVoucherNo] = useState("");
  const [data, setData] = useState({ labels: [], pickupLists: [] });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load(selectedDate = date) {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/acs-daily-labels?date=${encodeURIComponent(selectedDate)}`);
      const text = await res.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(text.slice(0, 300));
      }

      if (!res.ok || !json?.success) {
        throw new Error(json?.message || "Failed to load ACS daily labels.");
      }

      setData({
        labels: Array.isArray(json.labels) ? json.labels : [],
        pickupLists: Array.isArray(json.pickupLists) ? json.pickupLists : [],
      });
    } catch (e) {
      setError(e?.message || "Unexpected error.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(date);
  }, []);

  async function handleDelete(orderId, voucherNumber) {
    const ok = window.confirm(
      `Delete ACS voucher ${voucherNumber}? This works only if the voucher is not already included in a pickup list.`,
    );
    if (!ok) return;

    setNotice("");
    setError("");

    try {
      const res = await fetch(
        `/api/acs-cancel-voucher?number=${encodeURIComponent(voucherNumber)}&orderId=${encodeURIComponent(orderId)}`,
      );
      const text = await res.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(text.slice(0, 300));
      }

      if (!res.ok || !json?.success) {
        throw new Error(json?.message || "Failed to delete ACS voucher.");
      }

      setNotice(json.message || "Voucher deleted.");
      await load(date);
    } catch (e) {
      setError(e?.message || "Unexpected delete error.");
    }
  }

  async function handleManualDelete() {
    const voucherNumber = String(manualVoucherNo || "").trim();
    if (!voucherNumber) {
      setError("Please enter an ACS voucher number.");
      return;
    }

    const ok = window.confirm(
      `Delete ACS voucher ${voucherNumber}? This manual action deletes the voucher in ACS, but it will not clear Shopify metafields unless the order is known.`,
    );
    if (!ok) return;

    setManualDeleting(true);
    setNotice("");
    setError("");

    try {
      const res = await fetch(
        `/api/acs-cancel-voucher?number=${encodeURIComponent(voucherNumber)}`,
      );
      const text = await res.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(text.slice(0, 300));
      }

      if (!res.ok || !json?.success) {
        throw new Error(json?.message || "Failed to delete ACS voucher.");
      }

      setNotice(
        json.message ||
          `ACS voucher ${voucherNumber} deleted. Shopify metafields were not touched because no order was specified.`,
      );
      setManualVoucherNo("");
      await load(date);
    } catch (e) {
      setError(e?.message || "Unexpected manual delete error.");
    } finally {
      setManualDeleting(false);
    }
  }

  async function handleIssuePickupList() {
    const ok = window.confirm(
      `Issue ACS pickup list for ${date}? Make sure all vouchers for this date have already been opened/printed.`,
    );
    if (!ok) return;

    setIssuing(true);
    setNotice("");
    setError("");

    try {
      const res = await fetch(
        `/api/acs-issue-pickup-list?pickupDate=${encodeURIComponent(date)}`,
      );
      const text = await res.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(text.slice(0, 300));
      }

      if (!res.ok || !json?.success) {
        let extra = "";
        if (Array.isArray(json?.unprintedVouchers) && json.unprintedVouchers.length) {
          extra = ` Unprinted vouchers: ${json.unprintedVouchers.join(", ")}`;
        }
        throw new Error((json?.message || "Failed to issue pickup list.") + extra);
      }

      setNotice(json.message || "Pickup list issued.");
      await load(date);
    } catch (e) {
      setError(e?.message || "Unexpected pickup list error.");
    } finally {
      setIssuing(false);
    }
  }

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>ACS Daily Labels</h1>

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 20,
        }}
      >
        <label>
          Date:&nbsp;
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{ padding: 8 }}
          />
        </label>

        <button onClick={() => load(date)} disabled={loading} style={{ padding: "8px 12px" }}>
          {loading ? "Loading..." : "Load labels"}
        </button>

        <button
          onClick={handleIssuePickupList}
          disabled={loading || issuing}
          style={{ padding: "8px 12px" }}
        >
          {issuing ? "Issuing..." : "Issue pickup list"}
        </button>
      </div>

      <div
        style={{
          marginBottom: 20,
          padding: 16,
          border: "1px solid #ddd",
          borderRadius: 8,
          background: "#fff",
        }}
      >
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 12 }}>
          Manual voucher deletion
        </h2>

        <p style={{ marginTop: 0, color: "#555", fontSize: 14 }}>
          Enter any ACS voucher number and delete it directly from ACS.
          This manual action does not clear Shopify metafields unless the voucher is also deleted through an order row above.
        </p>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="text"
            value={manualVoucherNo}
            onChange={(e) => setManualVoucherNo(e.target.value)}
            placeholder="Enter ACS voucher number"
            style={{
              padding: 10,
              minWidth: 260,
              border: "1px solid #ccc",
              borderRadius: 6,
            }}
          />

          <button
            onClick={handleManualDelete}
            disabled={manualDeleting}
            style={{
              padding: "10px 14px",
              border: "1px solid #d99",
              borderRadius: 6,
              background: "#fff7f7",
            }}
          >
            {manualDeleting ? "Deleting..." : "Delete voucher manually"}
          </button>
        </div>
      </div>

      {notice ? (
        <div style={{ marginBottom: 16, padding: 12, background: "#eef8ee", border: "1px solid #b9dfb9" }}>
          {notice}
        </div>
      ) : null}

      {error ? (
        <div style={{ marginBottom: 16, padding: 12, background: "#fdecec", border: "1px solid #efb3b3" }}>
          {error}
        </div>
      ) : null}

      <h2 style={{ fontSize: 20, marginBottom: 12 }}>Labels for {date}</h2>

      {loading ? (
        <p>Loading...</p>
      ) : data.labels.length === 0 ? (
        <p>No ACS labels found for this pickup date.</p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {data.labels.map((row) => (
            <div
              key={row.orderId + row.voucherNumber}
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: 16,
                background: "#fff",
              }}
            >
              <div style={{ marginBottom: 8 }}>
                <strong>{row.orderName}</strong> — Voucher: <strong>{row.voucherNumber}</strong>
              </div>

              <div style={{ fontSize: 14, marginBottom: 8 }}>
                Customer: {row.customerName || "—"} | City: {row.city || "—"} | ZIP: {row.zip || "—"} | Country: {row.country || "—"}
              </div>

              <div style={{ fontSize: 14, marginBottom: 8 }}>
                Pieces: {row.pieces} | COD: {row.isCOD ? "YES" : "NO"} | Pickup date: {row.pickupDate}
              </div>

              {row.shipmentNumbers?.length ? (
                <div style={{ fontSize: 14, marginBottom: 12 }}>
                  Shipments: {row.shipmentNumbers.join(", ")}
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(row.labels || []).map((l, idx) => (
                  <a
                    key={l.number}
                    href={addInlineParam(l.url)}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      padding: "8px 12px",
                      border: "1px solid #ccc",
                      borderRadius: 6,
                      textDecoration: "none",
                    }}
                  >
                    {row.labels.length > 1 ? `Print label #${idx + 1}` : "Print label"}
                  </a>
                ))}

                <button
                  onClick={() => handleDelete(row.orderId, row.voucherNumber)}
                  style={{
                    padding: "8px 12px",
                    border: "1px solid #d99",
                    borderRadius: 6,
                    background: "#fff7f7",
                  }}
                >
                  Delete voucher
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: 20, marginTop: 28, marginBottom: 12 }}>
        Pickup lists for {date}
      </h2>

      {loading ? null : data.pickupLists.length === 0 ? (
        <p>No ACS pickup lists found for this date.</p>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {data.pickupLists.map((pl) => (
            <div
              key={pl.pickupListNo}
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: 16,
                background: "#fff",
              }}
            >
              <div style={{ marginBottom: 8 }}>
                <strong>PickupList_No:</strong> {pl.pickupListNo}
              </div>
              <div style={{ fontSize: 14, marginBottom: 12 }}>
                Created at: {pl.pickupListDateTime || "—"} | Vouchers: {pl.listVouchersCount}
              </div>

              <a
                href={addInlineParam(pl.pdfUrl)}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "8px 12px",
                  border: "1px solid #ccc",
                  borderRadius: 6,
                  textDecoration: "none",
                }}
              >
                Print pickup list PDF
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
