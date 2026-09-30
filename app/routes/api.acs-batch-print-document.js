import { PDFDocument } from "pdf-lib";
import { authenticate } from "../shopify.server";
import {
  extractPdfBytesFromAcsResponse,
  printAcsVoucher,
} from "../services/acs.server";

function safeStr(value) {
  return String(value ?? "").trim();
}

function errorHtml(message) {
  const escaped = safeStr(message).replace(
    /[&<>\"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
  return `<!doctype html><html><body><p>Could not load ACS labels: ${escaped}</p></body></html>`;
}

export async function loader({ request }) {
  let cors = (response) => response;

  try {
    const auth = await authenticate.admin(request);
    cors = auth.cors || cors;

    let vouchers;
    try {
      vouchers = JSON.parse(
        new URL(request.url).searchParams.get("vouchers") || "[]",
      );
    } catch {
      vouchers = [];
    }

    if (
      !Array.isArray(vouchers) ||
      !vouchers.length ||
      vouchers.length > 500 ||
      vouchers.some((number) => !/^[A-Za-z0-9-]{1,64}$/.test(safeStr(number)))
    ) {
      return cors(
        new Response(errorHtml("The ACS voucher list is invalid."), {
          status: 400,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }),
      );
    }

    const mergedPdf = await PDFDocument.create();
    for (const rawNumber of vouchers) {
      const number = safeStr(rawNumber);
      const printResponse = await printAcsVoucher(number, {
        printType: 1,
        startPosition: 1,
      });
      const pdfBytes = extractPdfBytesFromAcsResponse(printResponse);
      if (!pdfBytes) {
        throw new Error(
          `ACS returned no printable PDF bytes for voucher ${number}.`,
        );
      }
      const sourcePdf = await PDFDocument.load(pdfBytes);
      const pages = await mergedPdf.copyPages(
        sourcePdf,
        sourcePdf.getPageIndices(),
      );
      pages.forEach((page) => mergedPdf.addPage(page));
    }

    if (!mergedPdf.getPageCount()) {
      throw new Error("ACS returned no printable pages.");
    }

    const bytes = await mergedPdf.save();
    return cors(
      new Response(bytes, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="acs-batch-labels.pdf"',
          "Cache-Control": "no-store",
        },
      }),
    );
  } catch (error) {
    if (error instanceof Response) return error;
    return cors(
      new Response(errorHtml(error?.message || "Unknown ACS error."), {
        status: 500,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      }),
    );
  }
}
