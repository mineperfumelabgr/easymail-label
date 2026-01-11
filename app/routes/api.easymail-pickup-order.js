import { authenticate } from "../shopify.server";

const MF_NS = "easymail";
const MF_VOUCHER = "voucher_number";
const MF_CREATED = "voucher_created_at";

// ⚠️ Scegli endpoint: usa quello che già ti funziona in test/sandbox.
// Se vuoi PROD, sostituisci con quello prod.
const ESM_INSERT_PICKUP_ORDER =
  "https://webservices.easy-mail.gr/WcfServiceJSON2DOK/Service1.svc/InsertPickUpOrder";

function toEasyMailDate(yyyy_mm_dd) {
  return yyyy_mm_dd.replace(/-/g, "/"); // YYYY/MM/DD
}

function dayRangeLocal(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59`);
  return { start, end };
}

async function countVouchersEmittedOnDate(admin, dateStr) {
  const { start, end } = dayRangeLocal(dateStr);

  let hasNext = true;
  let cursor = null;
  let count = 0;

  while (hasNext) {
    const query = `#graphql
      query Orders($first: Int!, $after: String) {
        orders(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
          edges {
            cursor
            node {
              updatedAt
              mfVoucher: metafield(namespace: "${MF_NS}", key: "${MF_VOUCHER}") { value }
              mfCreated: metafield(namespace: "${MF_NS}", key: "${MF_CREATED}") { value }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `;

    const resp = await admin.graphql(query, { variables: { first: 100, after: cursor } });
    const json = await resp.json();

    if (json?.errors?.length) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
    }

    const edges = json?.data?.orders?.edges || [];
    hasNext = json?.data?.orders?.pageInfo?.hasNextPage || false;
    if (!edges.length) break;

    for (const e of edges) {
      cursor = e.cursor;

      const updatedAt = new Date(e.node.updatedAt);
      if (updatedAt < start) {
        hasNext = false;
        break;
      }

      const voucher = e.node?.mfVoucher?.value ? String(e.node.mfVoucher.value) : "";
      const createdAtStr = e.node?.mfCreated?.value ? String(e.node.mfCreated.value) : "";
      if (!voucher || !createdAtStr) continue;

      const createdAt = new Date(createdAtStr);
      if (createdAt >= start && createdAt <= end) count++;
    }
  }

  return count;
}

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // ✅ shop arriva dalla UI (hard-coded dev)
  const shop = url.searchParams.get("shop");
  const date = url.searchParams.get("date"); // YYYY-MM-DD

  if (!shop) {
    return Response.json({ success: false, message: "Missing shop" }, { status: 400 });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ success: false, message: "Invalid date (YYYY-MM-DD)" }, { status: 400 });
  }

  // ✅ Forziamo lo shop nell’header per evitare {shop:null}
  const req2 = new Request(request.url, {
    method: request.method,
    headers: {
      ...Object.fromEntries(request.headers),
      "X-Shopify-Shop-Domain": shop,
    },
  });

  const { admin, cors } = await authenticate.admin(req2);

  try {
    const vouchersCount = await countVouchersEmittedOnDate(admin, date);

    if (!vouchersCount) {
      return cors(
        Response.json(
          { success: false, message: "Nessun voucher emesso in questa data." },
          { status: 400 }
        )
      );
    }

    // 1 pezzo per voucher (semplice)
    const pieces = Math.max(1, Math.min(99, vouchersCount));

    // ✅ Dati pickup da ENV (mettili in .env)
    const principalId = Number(process.env.EASYMAIL_PICKUP_PRINCIPAL_ID || "0");
    const principalSenderConsignee = Number(
      process.env.EASYMAIL_PICKUP_PRINCIPAL_SENDER_CONSIGNEE || "2"
    );

    const senderName = process.env.EASYMAIL_PICKUP_SENDER_NAME || "MINE PERFUME LAB GR";
    const senderCity = process.env.EASYMAIL_PICKUP_SENDER_CITY || "Thessaloniki";
    const senderArea = process.env.EASYMAIL_PICKUP_SENDER_AREA || senderCity;
    const senderPostal = process.env.EASYMAIL_PICKUP_SENDER_POSTAL || "54623";
    const senderAddress =
      process.env.EASYMAIL_PICKUP_SENDER_ADDRESS || "Agias Sofias - Georg. Stavrou 11";
    const senderPhone = process.env.EASYMAIL_PICKUP_SENDER_PHONE || "2313036282";

    const user = process.env.EASYMAIL_USER;
    const pass = process.env.EASYMAIL_PASSWORD;

    if (!principalId) throw new Error("Missing EASYMAIL_PICKUP_PRINCIPAL_ID in .env");
    if (!user || !pass) throw new Error("Missing EASYMAIL_USER/EASYMAIL_PASSWORD in .env");

    // ✅ pickup “semplice”: ordini pronti, fascia default 14–18
    const pickUpOrder = {
      PrincipalID: principalId,
      PrincipalSenderConsignee: principalSenderConsignee,

      PickUpDate: toEasyMailDate(date),
      PickUpTimeFrom: "14/00",
      PickUpTimeTo: "18/00",
      PickUpPieces: pieces,

      PickUpDescription: "Orders ready for pickup",
      PickUpRemarks: `Vouchers created: ${vouchersCount}`,

      SenderName: senderName,
      SenderCity: senderCity,
      SenderArea: senderArea,
      SenderPostalCode: Number(senderPostal),
      SenderAddress: senderAddress,
      SenderPhoneNumber: senderPhone,

      // (se EasyMail richiede questi campi come "Yes", li compiliamo uguali al sender)
      ConsigneeName: senderName,
      ConsigneeCity: senderCity,
      ConsigneeArea: senderArea,
      ConsigneePostalCode: Number(senderPostal),
      ConsigneeAddress: senderAddress,
      ConsigneePhoneNumber1: senderPhone,
    };

    const body = {
      PickUpOrder: pickUpOrder,
      Credential: { UserName: user, Password: pass },
    };

    const apiResp = await fetch(ESM_INSERT_PICKUP_ORDER, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });

    const raw = await apiResp.text();
    let apiJson = null;
    try {
      apiJson = JSON.parse(raw);
    } catch {
  // ignore
}

    if (!apiResp.ok) {
      return cors(
        Response.json(
          {
            success: false,
            message: `EasyMail HTTP ${apiResp.status}`,
            details: raw.slice(0, 600),
          },
          { status: 500 }
        )
      );
    }

    if (!apiJson?.Result) {
      const msg =
        (Array.isArray(apiJson?.Messages) ? apiJson.Messages.join(" | ") : "") ||
        apiJson?.Message ||
        "EasyMail error";
      return cors(
        Response.json({ success: false, message: msg, raw: apiJson }, { status: 500 })
      );
    }

    return cors(
      Response.json({
        success: true,
        pickUpOrderId: apiJson.PickUpOrderID,
        pieces,
        vouchersCount,
      })
    );
  } catch (e) {
    return cors(
      Response.json({ success: false, message: e?.message || "Internal error" }, { status: 500 })
    );
  }
};

