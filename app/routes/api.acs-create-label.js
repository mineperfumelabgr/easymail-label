import { authenticate } from "../shopify.server";
import {
  clampPieces,
  createOrReuseAcsLabel,
  parseCodOverride,
  parsePickupDate,
} from "../services/acs-create-label.server";

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

function safeStr(v) {
  return String(v ?? "");
}

export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const orderGid = url.searchParams.get("orderId");
    if (!orderGid) return cors(jsonFAIL("Missing orderId", 400));

    const forceNew = url.searchParams.get("forceNew") === "1";
    const pieces = clampPieces(url.searchParams.get("pieces") || "1");
    const codOverride = parseCodOverride(url.searchParams.get("cod"));
    const requestedContentTypeIdRaw = safeStr(url.searchParams.get("contentTypeId"));
    const requestedContentTypeId = requestedContentTypeIdRaw
      ? Number(requestedContentTypeIdRaw)
      : 7;
    const requestedPickupDate = parsePickupDate(url.searchParams.get("pickupDate"));

    const result = await createOrReuseAcsLabel({
      admin,
      orderGid,
      forceNew,
      pieces,
      codOverride,
      requestedContentTypeId,
      requestedPickupDate,
    });

    return cors(jsonOK(result));
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("ACS CREATE LABEL ERROR:", e);
    return cors(jsonFAIL(e?.message || "Error while processing ACS request.", 200));
  }
}
