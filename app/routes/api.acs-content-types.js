import { authenticate } from "../shopify.server";
import { getAcsContentTypes, getAcsTableRows } from "../services/acs.server";

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
  return new Response(JSON.stringify({ success: true, ...payload }, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function jsonFAIL(message, status = 200, extra = {}) {
  return new Response(JSON.stringify({ success: false, message, ...extra }, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function loader({ request }) {
  try {
    await authenticate.admin(request);

    const data = await getAcsContentTypes();
    const rows = getAcsTableRows(data);

    return cors(
      jsonOK({
        rows,
      }),
    );
  } catch (e) {
    console.error("ACS CONTENT TYPES ERROR:", e);
    return cors(jsonFAIL(e?.message || "Error while loading ACS content types.", 200));
  }
}
