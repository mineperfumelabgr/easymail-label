import { authenticate } from "../shopify.server";

const NS = "easymail";
const KEY_CURRENT_NUMBERS = "current_numbers";
const KEY_VOUCHER = "voucher_number";

function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
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

async function getOrderMetafields(admin, orderGid) {
  const q = `#graphql
    query GetOrderMeta($id: ID!) {
      order(id: $id) {
        id
        name
        metafields(first: 60, namespace: "${NS}") {
          edges { node { key value } }
        }
      }
    }
  `;
  const j = await adminGraphql(admin, q, { id: orderGid });
  return j?.data?.order || null;
}

function extractMetafields(order) {
  const edges = order?.metafields?.edges || [];
  const mfs = edges.map((e) => e.node);
  const get = (key) => mfs.find((m) => m.key === key)?.value || "";
  return { get };
}

function makePdfUrl(number) {
  return `/api/easymail-label-pdf?number=${encodeURIComponent(String(number))}`;
}

export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");
    if (!orderId) {
      return cors(new Response("Missing orderId", { status: 400 }));
    }

    const order = await getOrderMetafields(admin, orderId);
    if (!order) {
      return cors(new Response("Order not found or access denied.", { status: 404 }));
    }

    const { get } = extractMetafields(order);

    const raw = String(get(KEY_CURRENT_NUMBERS) || "");
    const master = String(get(KEY_VOUCHER) || "");

    let numbers = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) numbers = parsed.map(String);
        // ignore
}
catch {
  // ignore
}

    }
    if (!numbers.length && master) numbers = [master];

    numbers = uniq(numbers);

    const links = numbers.map((n) => ({
      n,
      href: makePdfUrl(n),
    }));

    const title = `EasyMail labels for ${order.name || "order"}`;
    const linksHtml = links
      .map(
        (l, idx) =>
          `<li><a href="${escHtml(l.href)}" target="_blank" rel="noopener">Download label #${idx + 1} (ShipmentNumber: ${escHtml(l.n)})</a></li>`
      )
      .join("\n");

    // This page is opened via href from the Admin Action.
    // In a normal top-level context, browsers are MUCH more likely to allow multi-downloads.
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; padding: 16px; line-height: 1.4; }
    .box { max-width: 860px; margin: 0 auto; }
    button { padding: 10px 14px; font-size: 14px; cursor: pointer; }
    ul { margin-top: 12px; }
    .note { margin-top: 12px; color: #555; font-size: 13px; }
    .warn { margin-top: 12px; padding: 10px; background:#fff3cd; border:1px solid #ffeeba; border-radius:8px; }
  </style>
</head>
<body>
  <div class="box">
    <h2>${escHtml(title)}</h2>

    <p>Click the button below to download all labels. If your browser asks to allow multiple downloads, choose <b>Allow</b>.</p>

    <button id="dl">Download all (${links.length})</button>

    <div class="warn">
      <b>Tip:</b> Some browsers block multiple downloads by default. If nothing happens, check your browser bar/popup and allow downloads.
    </div>

    <ul>
      ${linksHtml}
    </ul>

    <p class="note">You can also download labels individually from the links above.</p>
  </div>

  <script>
    const urls = ${JSON.stringify(links.map((l) => l.href))};
    const btn = document.getElementById('dl');

    function triggerDownload(url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    btn.addEventListener('click', () => {
      // sequential to reduce blocking
      urls.forEach((u, i) => {
        setTimeout(() => triggerDownload(u), i * 500);
      });
    });

    // optional auto-start on load:
    // setTimeout(() => btn.click(), 400);
  </script>
</body>
</html>`;

    return cors(
      new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      })
    );
  } catch (e) {
    if (e instanceof Response) return e;
    return cors(new Response(e?.message || "Internal error", { status: 500 }));
  }
}

