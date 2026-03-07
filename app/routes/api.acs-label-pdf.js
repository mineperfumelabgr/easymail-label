import {
  extractPdfBytesFromAcsResponse,
  printAcsVoucher,
} from "../services/acs.server";

function pdfFail(message, status = 400) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function loader({ request }) {
  try {
    const url = new URL(request.url);
    const number = url.searchParams.get("number");

    if (!number) {
      return pdfFail("Missing ACS voucher number.");
    }

    const data = await printAcsVoucher(number, { printType: 1, startPosition: 1 });

    console.log("ACS PRINT VOUCHER RAW RESPONSE:");
    console.dir(data, { depth: 10 });

    const pdfBytes = extractPdfBytesFromAcsResponse(data);

    if (!pdfBytes) {
      return pdfFail("ACS returned no printable PDF bytes.");
    }

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="acs-${number}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("ACS LABEL PDF ERROR:", e);
    return pdfFail(e?.message || "Error while printing ACS voucher.", 500);
  }
}
