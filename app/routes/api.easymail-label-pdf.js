import { authenticate } from "../shopify.server";


const ESM_GET_VOUCHER_PDF_A6 =
  "https://webservices.easy-mail.gr/WcfServiceJSON2/Service1.svc/GetVoucherPDFA6Margins";


function safeFilename(name) {
  return String(name || "easymail-label.pdf")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
}

function toPdfBuffer(documentField) {
  if (typeof documentField === "string") {
    try {
      return Buffer.from(documentField, "base64");
    } catch {
      return Buffer.from(documentField, "utf8");
    }
  }

  if (Array.isArray(documentField)) {
    return Buffer.from(documentField);
  }

  if (
    documentField &&
    typeof documentField === "object" &&
    Array.isArray(documentField.$values)
  ) {
    return Buffer.from(documentField.$values);
  }

  return null;
}

export const loader = async ({ request }) => {
  const { cors } = await authenticate.admin(request);

  try {
    const url = new URL(request.url);
    const number = url.searchParams.get("number");
    const filenameParam = url.searchParams.get("filename");

    // NEW: inline=1 => open in browser tab (print-friendly)
    const inline = url.searchParams.get("inline") === "1";

    if (!number) {
      return cors(new Response("Missing number", { status: 400 }));
    }

    if (!process.env.EASYMAIL_USER || !process.env.EASYMAIL_PASSWORD) {
      return cors(new Response("Missing EasyMail credentials", { status: 500 }));
    }

    const pdfResp = await fetch(ESM_GET_VOUCHER_PDF_A6, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        Number: Number(number),
        Margin_Left: 0,
        Margin_Top: 0,
        Credential: {
          UserName: process.env.EASYMAIL_USER,
          Password: process.env.EASYMAIL_PASSWORD,
        },
      }),
    });

    const pdfJson = await pdfResp.json();

    if (!pdfJson?.Result) {
      const msg = pdfJson?.Message || "EasyMail PDF error";
      return cors(new Response(msg, { status: 500 }));
    }

    const pdfBuffer = toPdfBuffer(pdfJson.Document);

    if (!pdfBuffer || pdfBuffer.length < 10) {
      return cors(
        new Response(
          `PDF decode failed: unexpected Document format (${typeof pdfJson.Document})`,
          { status: 500 }
        )
      );
    }

    const magic = pdfBuffer.subarray(0, 5).toString("utf8");
    if (magic !== "%PDF-") {
      return cors(
        new Response(
          `Not a PDF. First bytes: ${JSON.stringify(
            pdfBuffer.subarray(0, 20).toString("utf8")
          )}`,
          { status: 500 }
        )
      );
    }

    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");

    const filename = safeFilename(
      filenameParam || `Easymail_Label_${yyyy}-${mm}-${dd}_${number}.pdf`
    );

    // ✅ inline opens in browser; attachment downloads
    const disposition = inline ? "inline" : "attachment";

    return cors(
      new Response(pdfBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `${disposition}; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      })
    );
  } catch (e) {
    return cors(new Response(e?.message || "Internal error", { status: 500 }));
  }
};

