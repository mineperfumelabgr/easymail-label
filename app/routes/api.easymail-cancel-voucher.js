import { authenticate } from "../shopify.server";

// LIVE JSON base (come hai confermato: togli DOK => JSON2)
const ESM_CANCEL_VOUCHER =
  "https://webservices.easy-mail.gr/WcfServiceJSON2/Service1.svc/CancelVoucher";

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

function pickMessage(j) {
  if (!j) return "";
  if (typeof j.Message === "string" && j.Message.trim()) return j.Message.trim();
  if (Array.isArray(j.Messages) && j.Messages.length) return j.Messages.filter(Boolean).join(" | ");
  return "";
}

async function callCancel(number) {
  if (!process.env.EASYMAIL_USER || !process.env.EASYMAIL_PASSWORD) {
    return { ok: false, message: "Missing EASYMAIL_USER / EASYMAIL_PASSWORD in .env" };
  }

  // Proviamo più payload shape (EasyMail cambia spesso formato tra servizi)
  const payloads = [
    { Number: Number(number), Credential: { UserName: process.env.EASYMAIL_USER, Password: process.env.EASYMAIL_PASSWORD } },
    { ShipmentNumber: Number(number), Credential: { UserName: process.env.EASYMAIL_USER, Password: process.env.EASYMAIL_PASSWORD } },
    { Voucher: { ShipmentNumber: Number(number) }, Credential: { UserName: process.env.EASYMAIL_USER, Password: process.env.EASYMAIL_PASSWORD } },
  ];

  let lastPreview = "";
  for (const bodyObj of payloads) {
    const resp = await fetch(ESM_CANCEL_VOUCHER, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(bodyObj),
    });

    const txt = await resp.text();
    lastPreview = (txt || "").slice(0, 400);

    let j;
    try {
      j = JSON.parse(txt);
    } catch {
      // Non è JSON (strano), proviamo prossimo formato
      continue;
    }

    // Se abbiamo un campo Result, consideriamo la risposta valida
    if (typeof j?.Result === "boolean") {
      const msg = pickMessage(j) || (j.Result ? "OK" : "Cancel failed");
      return {
        ok: true,
        result: j.Result,
        canceled: Boolean(j.Canceled),
        message: msg,
        raw: j,
      };
    }
  }

  return {
    ok: false,
    message: "EasyMail CancelVoucher did not return a valid JSON response (or unknown payload format).",
    preview: lastPreview,
  };
}

export async function loader({ request }) {
  // Auth Shopify (manteniamo la stessa logica dell'app)
  await authenticate.admin(request);

  const url = new URL(request.url);
  const numberRaw = (url.searchParams.get("number") || "").trim();

  if (!numberRaw) return cors(jsonOK({ result: false, canceled: false, message: "Missing number" }));

  const number = Number(numberRaw);
  if (!Number.isFinite(number) || number <= 0) {
    return cors(jsonOK({ result: false, canceled: false, message: "Invalid voucher number" }));
  }

  try {
    const out = await callCancel(number);

    if (!out.ok) {
      return cors(
        jsonOK({
          result: false,
          canceled: false,
          message: out.message,
          preview: out.preview || "",
        })
      );
    }

    return cors(
      jsonOK({
        result: out.result,
        canceled: out.canceled,
        message: out.message,
      })
    );
  } catch (e) {
    return cors(jsonOK({ result: false, canceled: false, message: e?.message || "Internal error" }));
  }
}

