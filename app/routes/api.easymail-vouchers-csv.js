import { authenticate } from "../shopify.server";

const NS = "easymail";
const KEY_VOUCHER = "voucher_number";
const KEY_CREATED_AT = "created_at";
const KEY_LABEL_URL = "label_url";
const KEY_PIECES = "pieces";

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

export const loader = async ({ request }) => {
  const { admin, cors } = await authenticate.admin(request);

  try {
    const url = new URL(request.url);
    const date = url.searchParams.get("date"); // YYYY-MM-DD

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return cors(
        Response.json({ success: false, message: "Invalid date (YYYY-MM-DD)" }, { status: 400 })
      );
    }

    // Nota: questa finestra è “locale del server”, ma filtriamo su created_at (metafield ISO) quindi ok.
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(`${date}T23:59:59`);

    let hasNext = true;
    let cursor = null;

    const rows = [];
    rows.push([
      "order_name",
      "voucher_number",
      "pieces",
      "created_at",
      "label_url",
      "order_updated_at",
      "customer_name",
      "destination_country",
      "destination_city",
      "destination_zip",
    ]);

    while (hasNext) {
      const q = `#graphql
        query Orders($first: Int!, $after: String) {
          orders(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
            edges {
              cursor
              node {
                name
                updatedAt
                customer { displayName }
                shippingAddress { countryCodeV2 city zip }

                mfVoucher: metafield(namespace: "${NS}", key: "${KEY_VOUCHER}") { value }
                mfCreated: metafield(namespace: "${NS}", key: "${KEY_CREATED_AT}") { value }
                mfLabel: metafield(namespace: "${NS}", key: "${KEY_LABEL_URL}") { value }
                mfPieces: metafield(namespace: "${NS}", key: "${KEY_PIECES}") { value }
              }
            }
            pageInfo { hasNextPage }
          }
        }
      `;

      const resp = await admin.graphql(q, { variables: { first: 100, after: cursor } });
      const json = await resp.json();

      if (json?.errors?.length) {
        return cors(
          Response.json(
            { success: false, message: `Shopify error: ${JSON.stringify(json.errors)}` },
            { status: 500 }
          )
        );
      }

      const edges = json?.data?.orders?.edges || [];
      hasNext = json?.data?.orders?.pageInfo?.hasNextPage || false;

      if (!edges.length) break;

      for (const e of edges) {
        cursor = e.cursor;

        const node = e.node;

        // Early stop: orders sorted by updatedAt desc
        const updatedAt = new Date(node.updatedAt);
        if (updatedAt < start) {
          hasNext = false;
          break;
        }

        const voucher = node?.mfVoucher?.value ? String(node.mfVoucher.value) : "";
        const createdAtStr = node?.mfCreated?.value ? String(node.mfCreated.value) : "";
        if (!voucher || !createdAtStr) continue;

        const createdAt = new Date(createdAtStr);
        if (createdAt < start || createdAt > end) continue;

        const pieces = node?.mfPieces?.value ? String(node.mfPieces.value) : "";
        const labelUrl = node?.mfLabel?.value ? String(node.mfLabel.value) : "";
        const customerName = node?.customer?.displayName || "";
        const ship = node?.shippingAddress || {};

        rows.push([
          node.name || "",
          voucher,
          pieces || "",
          createdAtStr,
          labelUrl || "",
          node.updatedAt || "",
          customerName,
          ship.countryCodeV2 || "",
          ship.city || "",
          ship.zip || "",
        ]);
      }
    }

    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");

    return cors(
      new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="easymail-vouchers-${date}.csv"`,
        },
      })
    );
  } catch (e) {
    return cors(
      Response.json({ success: false, message: e?.message || "Internal error" }, { status: 500 })
    );
  }
};

