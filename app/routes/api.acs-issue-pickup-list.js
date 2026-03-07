import { authenticate } from "../shopify.server";
import {
  extractIssuePickupListResult,
  issueAcsPickupList,
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
    throw new Error("Pickup date must be in YYYY-MM-DD format.");
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
    await authenticate.admin(request);

    const url = new URL(request.url);
    const pickupDate = parseDate(url.searchParams.get("pickupDate"));

    const resp = await issueAcsPickupList(pickupDate);
    const result = extractIssuePickupListResult(resp);

    if (!result.pickupListNo) {
      return cors(
        jsonFAIL(
          result.errorMessage || "ACS could not issue the pickup list.",
          200,
          {
            pickupDate,
            unprintedFound: result.unprintedFound,
            unprintedVouchers: result.unprintedVouchers,
          },
        ),
      );
    }

    return cors(
      jsonOK({
        pickupDate,
        pickupListNo: result.pickupListNo,
        message: `ACS pickup list issued successfully: ${result.pickupListNo}`,
      }),
    );
  } catch (e) {
    console.error("ACS ISSUE PICKUP LIST ERROR:", e);
    return cors(jsonFAIL(e?.message || "Error while issuing ACS pickup list.", 200));
  }
}
