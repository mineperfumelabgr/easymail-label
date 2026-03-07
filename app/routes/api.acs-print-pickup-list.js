import {
  extractPdfBytesFromAcsResponse,
  printAcsPickupList,
} from "../services/acs.server";

function safeStr(v) {
  return String(v ?? "");
}

function pdfFail(message, status = 400) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function loader({ request }) {
  try {
    const url = new URL(request.url);
    const massNumber = safeStr(url.searchParams.get("massNumber"));
    const pickupDate = safeStr(url.searchParams.get("pickupDate"));

    if (!massNumber) return pdfFail("Missing massNumber.");
    if (!pickupDate) return pdfFail("Missing pickupDate.");

    const data = await printAcsPickupList(massNumber, pickupDate);
    const pdfBytes = extractPdfBytesFromAcsResponse(data);

    if (!pdfBytes) {
      console.log("ACS PRINT PICKUP LIST RAW RESPONSE:");
      console.dir(data, { depth: 8 });
      return pdfFail("ACS returned no printable pickup list PDF bytes.");
    }

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="acs-pickup-list-${massNumber}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("ACS PICKUP LIST PDF ERROR:", e);
    return pdfFail(e?.message || "Error while printing ACS pickup list.", 500);
  }
}
