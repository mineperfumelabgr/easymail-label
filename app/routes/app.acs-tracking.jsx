import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useLocation, useNavigate, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const ALERT_STATUSES = ["DELIVERY_PROBLEM", "DELIVERY_ATTEMPTED", "DELIVERY_DELAYED"];
const FILTERS = ["ALL", "ALERTS", "RETURNS", "PICKUP", "DELIVERY", "TRANSIT", "DELIVERED", "LABEL_CREATED", "SYNC_ERROR"];
const STATUS_LABELS = {
  en: {
    DELIVERY_PROBLEM: "Delivery problem", DELIVERY_ATTEMPTED: "Delivery attempted", DELIVERY_DELAYED: "Delivery delayed",
    IN_TRANSIT: "In transit", OUT_FOR_DELIVERY: "Out for delivery", READY_FOR_PICKUP: "Ready for pickup",
    RETURNING: "Returning to sender", RETURNED: "Returned to sender", DELIVERED: "Delivered to recipient",
    LABEL_CREATED: "Label created · awaiting ACS pickup", UNKNOWN: "Check ACS status", SYNC_ERROR: "Sync issue",
  },
  el: {
    DELIVERY_PROBLEM: "Πρόβλημα παράδοσης", DELIVERY_ATTEMPTED: "Ανεπιτυχής προσπάθεια", DELIVERY_DELAYED: "Καθυστέρηση παράδοσης",
    IN_TRANSIT: "Σε μεταφορά", OUT_FOR_DELIVERY: "Προς παράδοση", READY_FOR_PICKUP: "Για παραλαβή",
    RETURNING: "Επιστροφή στον αποστολέα", RETURNED: "Επιστράφηκε στον αποστολέα", DELIVERED: "Παραδόθηκε στον παραλήπτη",
    LABEL_CREATED: "Δημιουργήθηκε ετικέτα · αναμονή παραλαβής ACS", UNKNOWN: "Έλεγχος κατάστασης ACS", SYNC_ERROR: "Πρόβλημα συγχρονισμού",
  },
};
const COPY = {
  en: {
    title: "ACS shipment dashboard", subtitle: "ACS shipment status and Shopify fulfillment are shown separately.",
    total: "Tracked shipments", attention: "Needs attention", returns: "Returns", delivery: "Out for delivery", delivered: "Delivered",
    search: "Search tracking, order or recipient", searchButton: "Search", refresh: "Refresh ACS tracking", refreshing: "Checking ACS…",
    all: "All", alerts: "Issues", returnsFilter: "Returns", pickup: "Pickup", deliveryFilter: "Out for delivery", transit: "In transit", deliveredFilter: "Delivered", labelCreated: "Awaiting pickup", syncError: "Sync issues",
    status: "ACS status", fulfillment: "Shopify fulfillment", order: "Order / recipient", voucher: "ACS tracking", checkpoint: "Latest ACS update", checked: "Last checked",
    created: "Created", deliveredAt: "Delivered", age: "Open for", days: "days", day: "day", syncIssue: "Sync issue", noResults: "No shipments match this search or filter.", empty: "No ACS shipments synced yet. Use Refresh ACS tracking to start.",
    deliveredRule: "Delivered is recorded only when ACS confirms delivery flags. SMS and message checkpoints are not proof of delivery.",
    syncResult: (r) => `Checked ${r.checked} vouchers · ${r.created} Shopify events · ${r.tagsAdded || 0} order tags added · ${r.alerts} shipments need attention${r.errors?.length ? ` · ${r.errors.length} sync errors` : ""}${r.tagErrors?.length ? ` · ${r.tagErrors.length} tag errors` : ""}.`,
    wait: (seconds) => `ACS is checking shipments… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}. Larger batches can take a few minutes.`,
    error: "Could not refresh ACS tracking.", language: "Language", en: "English", el: "Ελληνικά",
  },
  el: {
    title: "Πίνακας αποστολών ACS", subtitle: "Η κατάσταση ACS και η εκπλήρωση παραγγελίας Shopify εμφανίζονται ξεχωριστά.",
    total: "Παρακολουθούμενες", attention: "Χρειάζονται προσοχή", returns: "Επιστροφές", delivery: "Προς παράδοση", delivered: "Παραδόθηκαν",
    search: "Αναζήτηση tracking, παραγγελίας ή παραλήπτη", searchButton: "Αναζήτηση", refresh: "Ανανέωση tracking ACS", refreshing: "Έλεγχος ACS…",
    all: "Όλες", alerts: "Προβλήματα", returnsFilter: "Επιστροφές", pickup: "Παραλαβή", deliveryFilter: "Προς παράδοση", transit: "Σε μεταφορά", deliveredFilter: "Παραδόθηκαν", labelCreated: "Αναμονή παραλαβής", syncError: "Σφάλματα συγχρονισμού",
    status: "Κατάσταση ACS", fulfillment: "Εκπλήρωση Shopify", order: "Παραγγελία / παραλήπτης", voucher: "Tracking ACS", checkpoint: "Τελευταία ενημέρωση ACS", checked: "Τελευταίος έλεγχος",
    created: "Δημιουργήθηκε", deliveredAt: "Παραδόθηκε", age: "Ανοιχτό για", days: "ημέρες", day: "ημέρα", syncIssue: "Σφάλμα συγχρονισμού", noResults: "Δεν βρέθηκαν αποστολές για την αναζήτηση ή το φίλτρο.", empty: "Δεν υπάρχουν συγχρονισμένες αποστολές ACS. Πατήστε Ανανέωση tracking ACS.",
    deliveredRule: "Η παράδοση επιβεβαιώνεται μόνο από τα στοιχεία παράδοσης της ACS. Τα SMS και τα μηνύματα δεν θεωρούνται απόδειξη παράδοσης.",
    syncResult: (r) => `Ελέγχθηκαν ${r.checked} tracking · ${r.created} ενημερώσεις Shopify · ${r.tagsAdded || 0} tags παραγγελίας · ${r.alerts} αποστολές χρειάζονται προσοχή${r.errors?.length ? ` · ${r.errors.length} σφάλματα` : ""}${r.tagErrors?.length ? ` · ${r.tagErrors.length} σφάλματα tag` : ""}.`,
    wait: (seconds) => `Έλεγχος αποστολών ACS… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}. Μεγάλες λίστες μπορεί να χρειαστούν λίγα λεπτά.`,
    error: "Δεν ήταν δυνατή η ανανέωση του tracking ACS.", language: "Γλώσσα", en: "English", el: "Ελληνικά",
  },
};

function filterWhere(filter) {
  if (filter === "ALERTS") return { status: { in: ALERT_STATUSES } };
  if (filter === "RETURNS") return { status: { in: ["RETURNING", "RETURNED"] } };
  if (filter === "PICKUP") return { status: "READY_FOR_PICKUP" };
  if (filter === "DELIVERY") return { status: "OUT_FOR_DELIVERY" };
  if (filter === "TRANSIT") return { status: "IN_TRANSIT" };
  if (filter === "DELIVERED") return { status: "DELIVERED" };
  if (filter === "LABEL_CREATED") return { status: "LABEL_CREATED" };
  if (filter === "SYNC_ERROR") return { error: { not: null } };
  return {};
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const requestedFilter = url.searchParams.get("status") || "ALL";
  const filter = FILTERS.includes(requestedFilter) ? requestedFilter : "ALL";
  const lang = url.searchParams.get("lang") === "el" ? "el" : "en";
  const where = { shop: session.shop, ...filterWhere(filter) };
  if (q) where.OR = [
    { voucherNo: { contains: q, mode: "insensitive" } },
    { orderName: { contains: q, mode: "insensitive" } },
    { recipientName: { contains: q, mode: "insensitive" } },
  ];
  const [shipments, grouped, syncErrorCount, alertSyncErrors, totalCount] = await Promise.all([
    prisma.acsTrackingSnapshot.findMany({ where, orderBy: [{ fulfillmentCreatedAt: "desc" }, { lastCheckedAt: "desc" }], take: 500 }),
    prisma.acsTrackingSnapshot.groupBy({ by: ["status"], where: { shop: session.shop }, _count: { _all: true } }),
    prisma.acsTrackingSnapshot.count({ where: { shop: session.shop, error: { not: null } } }),
    prisma.acsTrackingSnapshot.count({ where: { shop: session.shop, error: { not: null }, status: { in: ALERT_STATUSES } } }),
    prisma.acsTrackingSnapshot.count({ where: { shop: session.shop } }),
  ]);
  shipments.sort((a, b) => new Date(b.fulfillmentCreatedAt || b.lastCheckedAt) - new Date(a.fulfillmentCreatedAt || a.lastCheckedAt));
  const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
  return { shipments, counts, q, filter, shop: session.shop, syncErrorCount, alertSyncErrors, totalCount, lang };
}

function dateLabel(value, lang) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(lang === "el" ? "el-GR" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Athens" }).format(new Date(value));
}
function ageDays(value) {
  if (!value) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000));
}
function localizedError(error, lang) {
  if (!error) return "";
  if (String(error).toLowerCase().includes("acs non ha restituito lo stato riepilogativo")) return lang === "el" ? "Η ετικέτα δημιουργήθηκε. Αναμένεται η παραλαβή από την ACS." : "Label created; waiting for ACS pickup.";
  return error;
}
function fulfillmentLabel(status, lang) {
  if (!status) return "—";
  const names = {
    en: { SUCCESS: "Fulfilled", FULFILLED: "Fulfilled", PARTIAL: "Partially fulfilled", RESTOCKED: "Restocked", OPEN: "Open", CANCELLED: "Cancelled", IN_TRANSIT: "In transit", DELIVERED: "Delivered", OUT_FOR_DELIVERY: "Out for delivery", FAILURE: "Delivery failure", READY_FOR_PICKUP: "Ready for pickup", PICKED_UP: "Picked up", DELAYED: "Delayed", ATTEMPTED_DELIVERY: "Attempted delivery" },
    el: { SUCCESS: "Εκπληρώθηκε", FULFILLED: "Εκπληρώθηκε", PARTIAL: "Μερική εκπλήρωση", RESTOCKED: "Επιστράφηκε στο απόθεμα", OPEN: "Ανοιχτή", CANCELLED: "Ακυρώθηκε", IN_TRANSIT: "Σε μεταφορά", DELIVERED: "Παραδόθηκε", OUT_FOR_DELIVERY: "Προς παράδοση", FAILURE: "Αποτυχία παράδοσης", READY_FOR_PICKUP: "Για παραλαβή", PICKED_UP: "Παραλήφθηκε", DELAYED: "Καθυστέρηση", ATTEMPTED_DELIVERY: "Ανεπιτυχής προσπάθεια" },
  };
  return names[lang][status] || status.replaceAll("_", " ").toLowerCase();
}

export default function AcsTrackingPage() {
  const { shipments, counts, q: initialQuery, filter: initialFilter, shop, syncErrorCount, alertSyncErrors, totalCount, lang } = useLoaderData();
  const t = COPY[lang];
  const fetcher = useFetcher();
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [query, setQuery] = useState(initialQuery);
  const [syncStartedAt, setSyncStartedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const elapsed = syncStartedAt ? Math.max(0, Math.floor((now - syncStartedAt) / 1000)) : 0;
  const attentionCount = ALERT_STATUSES.reduce((sum, status) => sum + (counts[status] || 0), 0) + syncErrorCount - alertSyncErrors;
  const openReturns = (counts.RETURNING || 0) + (counts.RETURNED || 0);

  useEffect(() => {
    if (fetcher.state === "idle" && syncStartedAt) setSyncStartedAt(null);
    if (fetcher.state === "idle" && result?.success) revalidator.revalidate();
  }, [fetcher.state, result?.success, revalidator, syncStartedAt]);
  useEffect(() => { setQuery(initialQuery); }, [initialQuery]);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  function navigateWithParams(updates) {
    const params = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value); else params.delete(key);
    }
    navigate(`${location.pathname}?${params.toString()}`);
  }
  function doSearch(event) {
    event.preventDefault();
    navigateWithParams({ q: query.trim() });
  }

  return (
    <s-page heading={t.title}>
      <s-section>
        <div className="acs-head"><div><p>{t.subtitle}</p><p className="acs-note">{t.deliveredRule}</p></div><div className="acs-lang" aria-label={t.language}><span>{t.language}</span><button type="button" className={lang === "en" ? "selected" : ""} onClick={() => navigateWithParams({ lang: "en" })}>{t.en}</button><button type="button" className={lang === "el" ? "selected" : ""} onClick={() => navigateWithParams({ lang: "el" })}>{t.el}</button></div></div>
        <div className="acs-kpis">
          <div><span>{t.total}</span><strong>{totalCount}</strong></div>
          <div className={attentionCount ? "attention" : ""}><span>{t.attention}</span><strong>{attentionCount}</strong></div>
          <div><span>{t.returns}</span><strong>{openReturns}</strong></div>
          <div><span>{t.delivery}</span><strong>{counts.OUT_FOR_DELIVERY || 0}</strong></div>
          <div><span>{t.delivered}</span><strong>{counts.DELIVERED || 0}</strong></div>
        </div>
        <div className="acs-toolbar">
          <form onSubmit={doSearch}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.search} aria-label={t.search} />
            <button type="submit">{t.searchButton}</button>
          </form>
          <s-button variant="primary" disabled={busy} onClick={() => { setSyncStartedAt(Date.now()); setNow(Date.now()); fetcher.submit({}, { method: "post", action: `/api/acs-tracking-sync${location.search}` }); }}>
            {busy ? t.refreshing : t.refresh}
          </s-button>
        </div>
        {busy ? <p className="acs-wait" role="status">{t.wait(elapsed)}</p> : null}
        {result?.success ? <p role="status" className="acs-result">{t.syncResult(result)}</p> : null}
        {result && !result.success ? <p role="alert">{result.message || t.error}</p> : null}
      </s-section>
      <s-section>
        <div className="acs-filters" aria-label={t.title}>
          {FILTERS.map((key) => {
            const names = { ALL: t.all, ALERTS: t.alerts, RETURNS: t.returnsFilter, PICKUP: t.pickup, DELIVERY: t.deliveryFilter, TRANSIT: t.transit, DELIVERED: t.deliveredFilter, LABEL_CREATED: t.labelCreated, SYNC_ERROR: t.syncError };
            const n = key === "ALL" ? totalCount : key === "ALERTS" ? ALERT_STATUSES.reduce((sum, status) => sum + (counts[status] || 0), 0) : key === "RETURNS" ? openReturns : key === "SYNC_ERROR" ? syncErrorCount : key === "LABEL_CREATED" ? counts.LABEL_CREATED || 0 : key === "PICKUP" ? counts.READY_FOR_PICKUP || 0 : key === "DELIVERY" ? counts.OUT_FOR_DELIVERY || 0 : key === "TRANSIT" ? counts.IN_TRANSIT || 0 : counts.DELIVERED || 0;
            return <button type="button" key={key} className={initialFilter === key ? "active" : ""} onClick={() => navigateWithParams({ status: key === "ALL" ? "" : key })}>{names[key]} <strong>{n}</strong></button>;
          })}
        </div>
        {shipments.length ? <div className="acs-table-wrap"><table className="acs-table">
          <thead><tr><th>{t.status}</th><th>{t.fulfillment}</th><th>{t.order}</th><th>{t.voucher}</th><th>{t.checkpoint}</th><th>{t.checked}</th></tr></thead>
          <tbody>{shipments.map((item) => {
            const critical = ALERT_STATUSES.includes(item.status) || item.status === "RETURNING" || item.status === "RETURNED" || Boolean(item.error);
            const orderNumber = item.orderId?.split("/").pop();
            const age = item.fulfillmentCreatedAt && !item.fulfillmentDeliveredAt ? ageDays(item.fulfillmentCreatedAt) : null;
            return <tr key={item.id} className={critical ? "needs-attention" : ""}>
              <td><span className={`status-pill state-${String(item.status).toLowerCase()} ${critical ? "critical" : ""}`}><i aria-hidden="true">{{DELIVERED:"✓",RETURNING:"↩",RETURNED:"↩",DELIVERY_PROBLEM:"!",DELIVERY_ATTEMPTED:"!",DELIVERY_DELAYED:"◷",READY_FOR_PICKUP:"⌂",OUT_FOR_DELIVERY:"➜",IN_TRANSIT:"●",LABEL_CREATED:"＋"}[item.status] || "·"}</i>{STATUS_LABELS[lang][item.status] || item.statusLabel}</span>{item.error ? <small className="sync-error">{t.syncIssue}: {localizedError(item.error, lang)}</small> : null}</td>
              <td><strong>{fulfillmentLabel(item.fulfillmentStatus, lang)}</strong><small>{t.created}: {dateLabel(item.fulfillmentCreatedAt, lang)}</small>{item.fulfillmentDeliveredAt ? <small>{t.deliveredAt}: {dateLabel(item.fulfillmentDeliveredAt, lang)}</small> : age !== null ? <small>{t.age} {age} {age === 1 ? t.day : t.days}</small> : null}</td>
              <td>{item.orderId ? <a href={`https://${shop}/admin/orders/${orderNumber}`} target="_top" rel="noreferrer">{item.orderName || "—"}</a> : <strong>{item.orderName || "Manual shipment"}</strong>}<small>{item.recipientName || "—"}</small></td>
              <td><a href={`https://webapp.acscourier.net/track-shipment/${encodeURIComponent(item.voucherNo)}`} target="_blank" rel="noreferrer"><strong>{item.voucherNo}</strong> ↗</a>{item.reasonCode ? <small>{item.reasonCode}</small> : null}</td>
              <td>{item.lastCheckpoint || "—"}{item.lastLocation ? <small>{item.lastLocation}</small> : null}<small>{dateLabel(item.lastEventAt, lang)}</small></td>
              <td>{dateLabel(item.lastCheckedAt, lang)}</td>
            </tr>;
          })}</tbody>
        </table></div> : <p>{totalCount ? t.noResults : t.empty}</p>}
      </s-section>
      <style>{`
        .acs-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.acs-head p{margin-top:0}.acs-note{font-size:12px;color:#716d68}.acs-lang{display:flex;align-items:center;gap:6px;white-space:nowrap;color:#6b6762;font-size:12px}.acs-lang button,.acs-toolbar form button,.acs-filters button{border:1px solid #dedad6;background:#fff;border-radius:7px;padding:8px 11px;font:inherit;cursor:pointer}.acs-lang button.selected{background:#614a38;color:white;border-color:#614a38}
        .acs-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:10px;margin:18px 0}.acs-kpis>div{border:1px solid #e5e1dc;border-radius:10px;padding:12px 14px;background:#fff;display:flex;flex-direction:column;gap:5px}.acs-kpis span,.acs-table small{color:#706d69;font-size:12px}.acs-kpis strong{font-size:21px;color:#282522}.acs-kpis .attention{border-color:#cf684c;background:#fff7f4}.acs-kpis .attention strong{color:#a63d25}
        .acs-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0}.acs-toolbar form{display:flex;gap:8px;flex:1;min-width:270px}.acs-toolbar input{flex:1;min-width:140px;padding:10px 12px;border:1px solid #c8c5c1;border-radius:8px;font:inherit}.acs-wait{color:#755b40}.acs-result{color:#315f35}
        .acs-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.acs-filters button{border-radius:999px}.acs-filters button.active{background:#614a38;color:white;border-color:#614a38}.acs-filters strong{margin-left:4px}
        .acs-table-wrap{overflow-x:auto}.acs-table{width:100%;border-collapse:collapse;font-size:13px}.acs-table th,.acs-table td{padding:11px 9px;border-bottom:1px solid #ece9e6;text-align:left;vertical-align:top}.acs-table th{font-weight:600;color:#605b56;white-space:nowrap}.acs-table td small{display:block;margin-top:4px;white-space:normal;min-width:110px;max-width:260px}.acs-table a{color:#59412f;font-weight:600}.acs-table tr.needs-attention{background:#fffaf8}.status-pill{display:inline-flex;align-items:center;gap:5px;border:1px solid #d5d0ca;border-radius:999px;padding:4px 8px;white-space:normal;background:#f6f6f7;color:#303030}.status-pill i{font-style:normal;font-weight:800}.state-delivered{background:#e4f3e8;color:#176b36;border-color:#a8d5b4}.state-returning,.state-returned{background:#fce8e6;color:#a12e20;border-color:#f2b8b5}.state-delivery_problem,.state-delivery_attempted,.state-delivery_delayed{background:#fff1d6;color:#7a4d00;border-color:#f1d59c}.state-ready_for_pickup{background:#e8eafa;color:#414a9b;border-color:#c5c9ed}.state-in_transit,.state-out_for_delivery{background:#e5f2fb;color:#145b89;border-color:#b6d8ef}.state-label_created{background:#f1f2f3;color:#50565c}.status-pill.critical{font-weight:650}.sync-error{color:#a33b25!important;font-weight:600}
        @media(max-width:700px){.acs-head{flex-direction:column}.acs-lang{align-self:flex-end}.acs-table{min-width:860px}}
      `}</style>
    </s-page>
  );
}
