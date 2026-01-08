import { authenticate } from "../shopify.server";

// stessa logica del pickup-order, ma restituisce HTML leggibile
const MF_NS = "easymail";
const MF_VOUCHER = "voucher_number";
const MF_CREATED = "voucher_created_at";

const ESM_INSERT_PICKUP_ORDER =
  "https://webservices.easy-mail.gr/WcfServiceJSON2DOK/Service1.svc/InsertPickUpOrder";

function toEasyMailDate(yyyy_mm_dd) {
  return yyyy_mm_dd.replace(/-/g, "/"); // YYYY/MM/DD
}
function toEasyMailTime(hhmm) {
  return String(hhmm || "").replace(":", "/"); // HH/MM
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
              metafield(namespace: "${MF_NS}", key: "${MF_VOUCHER}") { value }
              mfCreated: metafield(namespace: "${MF_NS}", key: "${MF_CREATED}") { value }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    `;

    const resp = await admin.graphql(query, { variables: { first: 100, after: cursor } });
    const json = await resp.json();
    if (json?.errors?.length) throw new Error(JSON.stringify(json.errors));

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

      const voucher = e.node?.metafield?.value ? String(e.node.metafield.value) : "";
      const createdAtStr = e.node?.mfCreated?.value ? String(e.node.mfCreated.value) : "";
      if (!voucher || !createdAtStr) continue;

      const createdAt = new Date(createdAtStr);
      if (createdAt >= start && createdAt <= end) count++;
    }
  }

  return count;
}

function htmlPage(title, bodyHtml) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px;line-height:1.4}
    .card{max-width:860px;border:1px solid #ddd;border-radius:12px;padding:18px}
    .ok{color:#0a7a2f}
    .err{color:#b42318}
    code{background:#f6f6f6;padding:2px 6px;border-radius:6px}
    a{color:#0b5fff}
  </style>
</head>
<body>
  <div class="card">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const date = url.searchParams.get("date"); // YYYY-MM-DD
  const timeFrom = url.searchParams.get("from") || "14:00";
  const timeTo = url.searchParams.get("to") || "18:00";

  try {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const html = htmlPage(
        "EasyMail Pickup - Errore",
        `<h2 class="err">Data non valida</h2><p>Usa formato <code>YYYY-MM-DD</code>.</p>`
      );
      return new Response(html, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    const vouchersCount = await countVouchersEmittedOnDate(admin, date);
    if (!vouchersCount) {
      const html = htmlPage(
        "EasyMail Pickup - Nessun voucher",
        `<h2 class="err">Nessun voucher emesso in questa data</h2>
         <p>Data: <code>${date}</code></p>
         <p>Genera prima le etichette e poi riprova.</p>`
      );
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    const pieces = Math.max(1, Math.min(99, vouchersCount));

    const principalId = Number(process.env.EASYMAIL_PICKUP_PRINCIPAL_ID || "0");
    const principalSenderConsignee = Number(
      process.env.EASYMAIL_PICKUP_PRINCIPAL_SENDER_CONSIGNEE || "2"
    );

    const senderName = process.env.EASYMAIL_PICKUP_SENDER_NAME || "";
    const senderCity = process.env.EASYMAIL_PICKUP_SENDER_CITY || "";
    const senderArea = process.env.EASYMAIL_PICKUP_SENDER_AREA || senderCity;
    const senderPostal = process.env.EASYMAIL_PICKUP_SENDER_POSTAL || "";
    const senderAddress = process.env.EASYMAIL_PICKUP_SENDER_ADDRESS || "";
    const senderPhone = process.env.EASYMAIL_PICKUP_SENDER_PHONE || "";

    const user = process.env.EASYMAIL_USER;
    const pass = process.env.EASYMAIL_PASSWORD;

    if (!principalId) throw new Error("Missing EASYMAIL_PICKUP_PRINCIPAL_ID in .env");
    if (!user || !pass) throw new Error("Missing EASYMAIL_USER / EASYMAIL_PASSWORD in .env");

    const pickUpOrder = {
      PrincipalID: principalId,
      PrincipalSenderConsignee: principalSenderConsignee,

      PickUpDate: toEasyMailDate(date),
      PickUpTimeFrom: toEasyMailTime(timeFrom),
      PickUpTimeTo: toEasyMailTime(timeTo),
      PickUpPieces: pieces,

      PickUpDescription: "Pickup",
      PickUpRemarks: `Vouchers: ${vouchersCount}`,

      SenderName: senderName,
      SenderCity: senderCity,
      SenderArea: senderArea,
      SenderPostalCode: Number(senderPostal),
      SenderAddress: senderAddress,
      SenderPhoneNumber: senderPhone,

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
    try { apiJson = JSON.parse(raw); } catch {}

    if (!apiResp.ok) {
      throw new Error(`EasyMail HTTP ${apiResp.status}: ${raw.slice(0, 500)}`);
    }
    if (!apiJson?.Result) {
      const msg =
        (Array.isArray(apiJson?.Messages) ? apiJson.Messages.join(" | ") : "") ||
        apiJson?.Message ||
        "EasyMail PickUpOrder error";
      throw new Error(msg);
    }

    const html = htmlPage(
      "EasyMail Pickup - OK",
      `<h2 class="ok">Pickup creato ✅</h2>
       <p><b>PickUpOrderID:</b> <code>${apiJson.PickUpOrderID}</code></p>
       <p><b>Data:</b> <code>${date}</code> • <b>Fascia:</b> <code>${timeFrom}–${timeTo}</code></p>
       <p><b>Spedizioni (pezzi):</b> <code>${pieces}</code> (voucher emessi: <code>${vouchersCount}</code>)</p>`
    );

    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  } catch (e) {
    const html = htmlPage(
      "EasyMail Pickup - Errore",
      `<h2 class="err">Errore</h2>
       <p>${String(e?.message || e)}</p>
       <p><b>Data:</b> <code>${date || ""}</code></p>`
    );
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
};

