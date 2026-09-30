import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  clampPieces,
  createOrReuseAcsLabel,
  parseCodAmountOverride,
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

async function addOrderTags(admin, orderId, tags) {
  const query = `#graphql
    mutation AddOrderTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  const response = await admin.graphql(query, {
    variables: { id: orderId, tags },
  });
  const json = await response.json();
  if (json?.errors?.length) {
    throw new Error(json.errors.map((item) => item.message).join(" | "));
  }
  const userErrors = json?.data?.tagsAdd?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors.map((item) => item.message).join(" | "));
  }
}

export async function loader({ request }) {
  try {
    const { admin, session } = await authenticate.admin(request);

    const url = new URL(request.url);
    const orderGid = url.searchParams.get("orderId");
    if (!orderGid) return cors(jsonFAIL("Missing orderId", 400));

    const forceNew = url.searchParams.get("forceNew") === "1";
    const pieces = clampPieces(url.searchParams.get("pieces") || "1");
    const codOverride = parseCodOverride(url.searchParams.get("cod"));
    const codAmountOverride = parseCodAmountOverride(url.searchParams.get("codAmount"));
    const requestedContentTypeIdRaw = safeStr(url.searchParams.get("contentTypeId"));
    const requestedContentTypeId = requestedContentTypeIdRaw
      ? Number(requestedContentTypeIdRaw)
      : 7;
    const requestedPickupDate = parsePickupDate(url.searchParams.get("pickupDate"));

    const employeeId = safeStr(url.searchParams.get("employeeId")).trim();
    if (!employeeId) {
      return cors(jsonFAIL("Select an employee before generating the label.", 400));
    }
    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, shop: session.shop },
      select: { name: true },
    });
    if (!employee) {
      return cors(jsonFAIL("The selected employee was not found.", 400));
    }

    let employeeTagWarning = "";
    try {
      await addOrderTags(admin, orderGid, [employee.name]);
    } catch (error) {
      employeeTagWarning = `Label generation can continue, but employee tag “${employee.name}” could not be added: ${error?.message || "unknown error"}`;
      console.error("ACS EMPLOYEE TAG ERROR:", error);
    }

    const result = await createOrReuseAcsLabel({
      admin,
      orderGid,
      forceNew,
      pieces,
      codOverride,
      codAmountOverride,
      requestedContentTypeId,
      requestedPickupDate,
    });

    return cors(jsonOK({ ...result, employeeTagWarning }));
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("ACS CREATE LABEL ERROR:", e);
    return cors(jsonFAIL(e?.message || "Error while processing ACS request.", 200));
  }
}
