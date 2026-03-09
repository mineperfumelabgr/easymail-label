import { PDFDocument } from "pdf-lib";
import { authenticate } from "../shopify.server";
import {
  createOrReuseAcsLabel,
  parsePickupDate,
} from "../services/acs-create-label.server";
import {
  extractPdfBytesFromAcsResponse,
  printAcsVoucher,
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
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const rawOrderIds = url.searchParams.get("orderIds");
    const pickupDate = parsePickupDate(url.searchParams.get("pickupDate"));

    if (!rawOrderIds) {
      return pdfFail("Missing orderIds.");
    }

    let orderIds;
    try {
      orderIds = JSON.parse(rawOrderIds);
    } catch {
      return pdfFail("Invalid orderIds format.");
    }

    if (!Array.isArray(orderIds) || !orderIds.length) {
      return pdfFail("No orders selected.");
    }

    const mergedPdf = await PDFDocument.create();

    for (const orderId of orderIds) {
      const result = await createOrReuseAcsLabel({
        admin,
        orderGid: String(orderId),
        forceNew: false,
        pieces: 1,
        codOverride: null,
        requestedContentTypeId: 7,
        requestedPickupDate: pickupDate,
      });

      const numbers =
        Array.isArray(result?.shipmentNumbers) && result.shipmentNumbers.length
          ? result.shipmentNumbers.map(String)
          : result?.voucherNumber
          ? [String(result.voucherNumber)]
          : [];

      for (const number of numbers) {
        const printResp = await printAcsVoucher(number, {
          printType: 1,
          startPosition: 1,
        });
        const pdfBytes = extractPdfBytesFromAcsResponse(printResp);

        if (!pdfBytes) {
          throw new Error(`ACS returned no printable PDF bytes for voucher ${number}.`);
        }

        const srcPdf = await PDFDocument.load(pdfBytes);
        const pages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
        pages.forEach((p) => mergedPdf.addPage(p));
      }
    }

    const mergedBytes = await mergedPdf.save();

    return new Response(mergedBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="acs-batch-${pickupDate}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("ACS BATCH MERGE PDF ERROR:", e);
    return pdfFail(e?.message || "Error while creating merged ACS labels PDF.", 500);
  }
}
