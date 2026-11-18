import {dailyAcsLabels} from "../services/acs-daily.server";
import { authenticate } from "../shopify.server";
import {
  extractPickupLists,
  getAcsPickupLists,
  makeAcsPickupListPdfUrl,
} from "../services/acs.server";

function safeStr(v) {
  return String(v ?? "");
}

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function parseDate(v) {
  const s = safeStr(v).trim();
  if (!s) return todayYMD();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error("Date must be in YYYY-MM-DD format.");
  }
  return s;
}

function withCorsHeaders(headers = {}) {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  };
}

function cors(resp) {
  const h = new Headers(resp.headers || {});
  const extra = withCorsHeaders(Object.fromEntries(h.entries()));
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: extra,
  });
}

function jsonOK(payload) {
  return new Response(JSON.stringify({ success: true, ...payload }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function jsonFAIL(message, status = 200, extra = {}) {
  return new Response(JSON.stringify({ success: false, message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const selectedDate = parseDate(url.searchParams.get("date"));

    const labels=await dailyAcsLabels(admin,selectedDate);
    let pickupLists = [];
    try {
      const pickupResp = await getAcsPickupLists(selectedDate);
      pickupLists = extractPickupLists(pickupResp).map((x) => ({
        ...x,
        pdfUrl: makeAcsPickupListPdfUrl(x.pickupListNo, selectedDate),
      }));
    } catch (e) {
      console.warn("ACS GET PICKUP LISTS warning:", e?.message || e);
    }

    return cors(
      jsonOK({
        date: selectedDate,
        labels,
        pickupLists,
      }),
    );
  } catch (e) {
    console.error("ACS DAILY LABELS ERROR:", e);
    return cors(jsonFAIL(e?.message || "Error while loading ACS daily labels.", 200));
  }
}
