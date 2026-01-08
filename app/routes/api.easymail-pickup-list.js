import { authenticate } from "../shopify.server";

const MF_NS = "easymail";
const MF_VOUCHER = "voucher_number";
const MF_CREATED = "voucher_created_at";

function csvEscape(v) {
  const s = String(v ?? "");
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function dayRangeLocal(dateStr) {
  // dateStr: YYYY-MM-DD -> start/end in local time (Athens on your Mac)
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59`);
  return { start, end };
}

async function fetchOrdersWithVoucherOnDate(admin, dateStr) {
  const { start, end } = dayRangeLocal(dateStr);

  let hasNext = true;
  let cursor = null;
  const matched = [];

  // Prendiamo gli ordini più recentemente aggiornati e filtriamo in base al metafield voucher_created_at
  // Stop quando gli ordini sono troppo vecchi (updatedAt < start) per evitare scansioni inutili
  while (hasNext) {
    const query = `#graphql
      query Orders($first: Int!, $after: String) {
        orders(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
          edges {
            cursor
            node {
              id
              name
              updatedAt
              shippingAddress {
                name
                address1
                address2
                city
                zip
                country
                phone
              }
              metafield(namespace: "${MF_NS}", key: "${MF_VOUCHER}") { value }
              metafieldCreated: metafield(namespace: "${MF_NS}", key: "${MF_CREATED}") { value }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `;

    const resp = await admin.graphql(query, {
      variables: { first: 100, after: cursor },
    });
    const json = await resp.json();

    if (json?.errors?.length) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
    }

    const edges = json?.data?.orders?.edges || [];
    hasNext = json?.data?.orders?.pageInfo?.hasNextPage || false;

    if (!edges.length) break;

    for (const e of edges) {
      cursor = e.cursor;

      const o = e.node;
      const updatedAt = new Date(o.updatedAt);

      // stop condition: se stiamo scendendo troppo indietro
      if (updatedAt < start) {
        hasNext = false;
        break;
      }

      const voucher = o?.metafield?.value ? String(o.metafield.value) : "";
      const createdAtStr = o?.metafieldCreated?.value
        ? String(o.metafieldCreated.value)
        : "";

      if (!voucher || !createdAtStr) continue;

      const createdAt = new Date(createdAtStr);
      if (createdAt >= start && createdAt <= end) {
        matched.push({
          orderId: o.id,
          name: o.name,
          voucher,
          createdAt: createdAtStr,
          ship: o.shippingAddress || {},
        });
      }
    }
  }

  return matched;
}

export const loader = async ({ request }) => {
  const { admin, cors } = await authenticate.admin(request);

  try {
    const url = new URL(request.url);
    const date = url.searchParams.get("date"); // YYYY-MM-DD

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return cors(new Response("Invalid date. Use YYYY-MM-DD", { status: 400 }));
    }

    const rows = await fetchOrdersWithVoucherOnDate(admin, date);

    const csvRows = [];
    csvRows.push([
      "Order",
      "VoucherNumber",
      "VoucherCreatedAt",
      "Name",
      "Address1",
      "Address2",
      "City",
      "ZIP",
      "Country",
      "Phone",
    ]);

    for (const r of rows) {
      const a = r.ship || {};
      csvRows.push([
        r.name,
        r.voucher,
        r.createdAt,
        a.name || "",
        a.address1 || "",
        a.address2 || "",
        a.city || "",
        a.zip || "",
        a.country || "",
        a.phone || "",
      ]);
    }

    // Se vuoto, lasciamo una riga informativa
    if (rows.length === 0) {
      csvRows.push([
        "Nessun voucher emesso in questa data",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]);
    }

    const csv = csvRows.map((r) => r.map(csvEscape).join(",")).join("\n");
    const filename = `Pickup_List_${date}.csv`;

    return cors(
      new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      })
    );
  } catch (e) {
    return cors(new Response(e?.message || "Internal error", { status: 500 }));
  }
};

