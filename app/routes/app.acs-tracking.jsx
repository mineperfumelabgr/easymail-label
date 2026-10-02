import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const FILTERS = [
  ["ALL", "Tutte"],
  ["DELIVERY_PROBLEM", "Problemi"],
  ["DELIVERY_ATTEMPTED", "Tentativo fallito"],
  ["DELIVERY_DELAYED", "Riprogrammate"],
  ["IN_TRANSIT", "In transito"],
  ["OUT_FOR_DELIVERY", "In consegna"],
  ["READY_FOR_PICKUP", "Da ritirare"],
  ["RETURNING", "In restituzione"],
  ["RETURNED", "Restituite"],
  ["DELIVERED", "Consegnate"],
  ["UNKNOWN", "Da verificare"],
  ["SYNC_ERROR", "Errori ACS"],
];
const ALERT_STATUSES = new Set(["DELIVERY_PROBLEM", "DELIVERY_ATTEMPTED", "DELIVERY_DELAYED", "RETURNING", "RETURNED", "SYNC_ERROR"]);

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const filter = FILTERS.some(([key]) => key === url.searchParams.get("status")) ? (url.searchParams.get("status") || "ALL") : "ALL";
  const where = { shop: session.shop };
  if (filter === "SYNC_ERROR") where.error = { not: null };
  else if (filter !== "ALL") where.status = filter;
  if (q) {
    where.OR = [
      { voucherNo: { contains: q, mode: "insensitive" } },
      { orderName: { contains: q, mode: "insensitive" } },
      { recipientName: { contains: q, mode: "insensitive" } },
    ];
  }
  const [shipments, grouped, syncErrorCount] = await Promise.all([
    prisma.acsTrackingSnapshot.findMany({ where, orderBy: { lastCheckedAt: "desc" }, take: 500 }),
    prisma.acsTrackingSnapshot.groupBy({ by: ["status"], where: { shop: session.shop }, _count: { _all: true } }),
    prisma.acsTrackingSnapshot.count({ where: { shop: session.shop, error: { not: null } } }),
  ]);
  const priority = { RETURNING: 0, DELIVERY_PROBLEM: 1, DELIVERY_ATTEMPTED: 2, DELIVERY_DELAYED: 3, SYNC_ERROR: 4, READY_FOR_PICKUP: 5, OUT_FOR_DELIVERY: 6, IN_TRANSIT: 7, UNKNOWN: 8, RETURNED: 9, DELIVERED: 10 };
  shipments.sort((a, b) => (priority[a.status] ?? 10) - (priority[b.status] ?? 10) || new Date(b.lastCheckedAt) - new Date(a.lastCheckedAt));
  const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
  return { shipments, counts, q, filter, shop: session.shop, syncErrorCount };
}

function dateLabel(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Athens" }).format(new Date(value));
}

export default function AcsTrackingPage() {
  const { shipments, counts, q: initialQuery, filter: initialFilter, shop, syncErrorCount } = useLoaderData();
  const fetcher = useFetcher();
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [query, setQuery] = useState(initialQuery);
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const allCount = useMemo(() => Object.values(counts).reduce((sum, value) => sum + value, 0), [counts]);
  const alertCount = useMemo(() => Object.entries(counts).reduce((sum, [key, value]) => sum + (key !== "SYNC_ERROR" && ALERT_STATUSES.has(key) ? value : 0), syncErrorCount), [counts, syncErrorCount]);

  useEffect(() => {
    if (fetcher.state === "idle" && result?.success) revalidator.revalidate();
  }, [fetcher.state, result?.success, revalidator]);
  useEffect(() => setQuery(initialQuery), [initialQuery]);

  function setFilter(status) {
    const params = new URLSearchParams(location.search);
    if (query) params.set("q", query); else params.delete("q");
    if (status === "ALL") params.delete("status"); else params.set("status", status);
    navigate(`${location.pathname}?${params.toString()}`);
  }

  return (
    <s-page heading="ACS Tracking">
      <s-section>
        <div className="tracking-summary">
          <div><span>Spedizioni monitorate</span><strong>{allCount}</strong></div>
          <div className={alertCount ? "tracking-alert" : ""}><span>Richiedono attenzione</span><strong>{alertCount}</strong></div>
          <div><span>In transito</span><strong>{counts.IN_TRANSIT || 0}</strong></div>
          <div><span>In consegna</span><strong>{counts.OUT_FOR_DELIVERY || 0}</strong></div>
          <div><span>Da ritirare</span><strong>{counts.READY_FOR_PICKUP || 0}</strong></div>
          <div><span>In restituzione</span><strong>{counts.RETURNING || 0}</strong></div>
          <div><span>Restituite</span><strong>{counts.RETURNED || 0}</strong></div>
          <div><span>Consegnate</span><strong>{counts.DELIVERED || 0}</strong></div>
          <div className={syncErrorCount ? "tracking-alert" : ""}><span>Errori aggiornamento</span><strong>{syncErrorCount}</strong></div>
        </div>
        {alertCount ? <p className="tracking-alert-banner" role="alert">Attenzione: {alertCount} spedizioni hanno problemi, tentativi falliti, aggiornamenti ACS non riusciti o stanno tornando al mittente.</p> : null}
        <p className="tracking-note">Una spedizione risulta consegnata solo se ACS conferma lo stato 4 con i flag di consegna corretti. SMS e messaggi al destinatario non vengono interpretati come prova di consegna.</p>
        <div className="tracking-toolbar">
          <form onSubmit={(event) => {
            event.preventDefault();
            const params = new URLSearchParams(location.search);
            if (query.trim()) params.set("q", query.trim()); else params.delete("q");
            navigate(`${location.pathname}?${params.toString()}`);
          }}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cerca codice ACS, nome o ordine Shopify" aria-label="Cerca spedizioni" />
            <button type="submit">Cerca</button>
          </form>
          <s-button variant="primary" disabled={busy} onClick={() => fetcher.submit({}, { method: "post", action: `/api/acs-tracking-sync${location.search}` })}>
            {busy ? "Aggiornamento in corso…" : "Aggiorna tracking ACS"}
          </s-button>
        </div>
        {result?.success ? <p role="status">Controllati {result.checked} voucher · {result.created} eventi inviati a Shopify · {result.alerts} spedizioni da verificare{result.errors?.length ? ` · ${result.errors.length} errori` : ""}.</p> : null}
        {result && !result.success ? <p role="alert">{result.message}</p> : null}
      </s-section>

      <s-section>
        <div className="tracking-filters" aria-label="Filtri spedizioni">
          {FILTERS.map(([key, label]) => (
            <button type="button" key={key} className={initialFilter === key ? "active" : ""} onClick={() => setFilter(key)}>
              {label}{key === "ALL" ? ` (${allCount})` : ` (${key === "SYNC_ERROR" ? syncErrorCount : counts[key] || 0})`}
            </button>
          ))}
        </div>
        {shipments.length ? (
          <div className="tracking-table-wrap">
            <table className="tracking-table">
              <thead><tr><th>Stato</th><th>Ordine / destinatario</th><th>Voucher ACS</th><th>Ultimo aggiornamento ACS</th><th>Ultimo checkpoint</th><th>Verificato</th></tr></thead>
              <tbody>{shipments.map((item) => {
                const critical = ALERT_STATUSES.has(item.status) || Boolean(item.error);
                const orderNumber = item.orderId.split("/").pop();
                return <tr key={item.id} className={critical ? "tracking-row-alert" : ""}>
                  <td><span className={`tracking-badge ${critical ? "critical" : ""}`}>{item.statusLabel}</span>{item.error ? <small className="tracking-error">{item.error}</small> : null}</td>
                  <td><a href={`https://${shop}/admin/orders/${orderNumber}`} target="_top" rel="noreferrer">{item.orderName}</a><small>{item.recipientName || "Destinatario non indicato"}</small></td>
                  <td><strong>{item.voucherNo}</strong>{item.reasonCode ? <small>Motivo ACS: {item.reasonCode}</small> : null}</td>
                  <td>{dateLabel(item.lastEventAt)}{item.lastLocation ? <small>{item.lastLocation}</small> : null}</td>
                  <td>{item.lastCheckpoint || "—"}</td>
                  <td>{dateLabel(item.lastCheckedAt)}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        ) : <p>{allCount ? "Nessuna spedizione corrisponde alla ricerca o al filtro." : "Nessuna spedizione ancora sincronizzata. Premi “Aggiorna tracking ACS” per importare stati ed eventi delle spedizioni ACS recenti."}</p>}
      </s-section>

      <style>{`
        .tracking-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px}
        .tracking-summary>div{border:1px solid #e5e1dc;border-radius:10px;padding:12px 14px;background:#fff;display:flex;flex-direction:column;gap:5px}
        .tracking-summary span,.tracking-table small{color:#706d69;font-size:12px}.tracking-summary strong{font-size:21px;color:#282522}
        .tracking-summary .tracking-alert{border-color:#cf684c;background:#fff7f4}.tracking-summary .tracking-alert strong{color:#a63d25}
        .tracking-alert-banner{padding:10px 13px;border-left:4px solid #bd5336;background:#fff3ee;color:#8d3621;border-radius:5px}
        .tracking-note{font-size:12px;color:#706d69}
        .tracking-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0}
        .tracking-toolbar form{display:flex;gap:8px;flex:1;min-width:280px}.tracking-toolbar input{flex:1;min-width:150px;padding:10px 12px;border:1px solid #c8c5c1;border-radius:8px;font:inherit}
        .tracking-toolbar form button,.tracking-filters button{background:#fff;border:1px solid #d9d5d1;border-radius:999px;padding:8px 13px;font:inherit;cursor:pointer}
        .tracking-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.tracking-filters button.active{background:#7b573f;color:#fff;border-color:#7b573f}
        .tracking-table-wrap{overflow-x:auto}.tracking-table{width:100%;border-collapse:collapse;font-size:13px}.tracking-table th,.tracking-table td{padding:11px 9px;border-bottom:1px solid #ece9e6;text-align:left;vertical-align:top;white-space:nowrap}.tracking-table th{font-weight:600;color:#605b56}
        .tracking-table td small{display:block;margin-top:4px;white-space:normal;max-width:230px}.tracking-table a{color:#59412f;font-weight:600}.tracking-row-alert{background:#fffaf8}
        .tracking-badge{display:inline-block;border:1px solid #d5d0ca;border-radius:999px;padding:4px 8px;white-space:normal}.tracking-badge.critical{border-color:#cc765a;color:#9b3924;background:#fff1eb}.tracking-error{color:#a33b25}
      `}</style>
    </s-page>
  );
}
