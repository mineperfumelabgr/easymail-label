import { authenticate } from "../shopify.server";
import { deleteAcsVoucher } from "../services/acs.server";

const NS = "acs";

const KEYS_TO_DELETE = [
  "voucher_number",
  "label_url",
  "created_at",
  "pieces",
  "voucher_history",
  "current_numbers",
  "content_type_id",
  "pickup_date",
];

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

async function adminGraphql(admin, query, variables) {
  const r = await admin.graphql(query, { variables });
  const j = await r.json();
  if (j?.errors?.length) {
    const msg = j.errors.map((e) => e.message).join(" | ");
    throw new Error(`Shopify GraphQL error: ${msg}`);
  }
  return j;
}

async function deleteMetafields(admin, orderId) {
  const m = `#graphql
    mutation DeleteMetafields($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields {
          key
          namespace
          ownerId
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    metafields: KEYS_TO_DELETE.map((key) => ({
      ownerId: orderId,
      namespace: NS,
      key,
    })),
  };

  const j = await adminGraphql(admin, m, variables);
  return j?.data?.metafieldsDelete?.userErrors || [];
}

function extractDeleteBusinessMessage(data) {
  const env = data?.ACSOutputResponce || data?.ACSOutputResponse || {};
  const rows = Array.isArray(env?.ACSValueOutput) ? env.ACSValueOutput : [];
  const first = rows[0] || {};

  const msg =
    first?.Error_Message ??
    first?.error_message ??
    first?.ErrorMessage ??
    first?.message ??
    "";

  return String(msg || "").trim();
}

function looksLikeVoucherNotFound(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("δεν") ||
    m.includes("not found") ||
    m.includes("not exist") ||
    m.includes("does not exist") ||
    m.includes("invalid") ||
    m.includes("unknown") ||
    m.includes("ανύπαρκ")
  );
}

export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const number = url.searchParams.get("number");
    const orderId = url.searchParams.get("orderId");

    if (!number) return cors(jsonFAIL("Missing ACS voucher number.", 400));

    const deleteResp = await deleteAcsVoucher(number);
    const businessMessage = extractDeleteBusinessMessage(deleteResp);

    if (businessMessage) {
      console.log("ACS DELETE BUSINESS MESSAGE:", businessMessage);

      if (looksLikeVoucherNotFound(businessMessage)) {
        return cors(
          jsonFAIL(`ACS voucher ${number} does not exist or cannot be deleted. ACS says: ${businessMessage}`, 200),
        );
      }

      // Any non-empty ACS message is safer to show to user instead of pretending success.
      return cors(
        jsonFAIL(`ACS did not confirm deletion of voucher ${number}. ACS says: ${businessMessage}`, 200),
      );
    }

    if (orderId) {
      const deleteErrors = await deleteMetafields(admin, orderId);

      if (deleteErrors.length) {
        console.log("ACS DELETE METAFIELD ERRORS:");
        console.dir(deleteErrors, { depth: 10 });

        return cors(
          jsonFAIL(
            `Voucher deleted in ACS, but Shopify metafields could not be fully deleted: ${deleteErrors
              .map((e) => e.message)
              .join(" | ")}`,
            200,
          ),
        );
      }
    }

    return cors(
      jsonOK({
        number: String(number),
        message: `ACS voucher ${number} deleted successfully.`,
      }),
    );
  } catch (e) {
    console.error("ACS DELETE ERROR:", e);
    return cors(jsonFAIL(e?.message || "Error while deleting ACS voucher.", 200));
  }
}
