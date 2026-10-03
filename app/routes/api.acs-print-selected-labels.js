import { PDFDocument } from "pdf-lib";
import { authenticate } from "../shopify.server";
import { extractPdfBytesFromAcsResponse, printAcsVoucher } from "../services/acs.server";

export async function action({ request }) {
  try {
    await authenticate.admin(request);
    const body = await request.json();
    const numbers = [...new Set((Array.isArray(body?.numbers) ? body.numbers : []).map((n) => String(n).trim()).filter((n) => /^\d+$/.test(n)))];
    if (!numbers.length || numbers.length > 100) return Response.json({ success: false, message: "Select between 1 and 100 vouchers." }, { status: 400 });
    const merged = await PDFDocument.create();
    const failures = [];
    for (const number of numbers) {
      try {
        const response = await printAcsVoucher(number, { printType: 1, startPosition: 1 });
        const bytes = extractPdfBytesFromAcsResponse(response);
        if (!bytes?.length) throw new Error("ACS returned an empty label PDF.");
        const pdf = await PDFDocument.load(bytes);
        const pages = await merged.copyPages(pdf, pdf.getPageIndices());
        pages.forEach((page) => merged.addPage(page));
      } catch (error) { failures.push({ number, message: error?.message || "Print failed" }); }
    }
    if (!merged.getPageCount()) return Response.json({ success: false, message: "No selected labels could be printed.", failures }, { status: 502 });
    const bytes = await merged.save();
    return new Response(bytes, { headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=acs-selected-labels.pdf", "Cache-Control": "no-store", "X-ACS-Print-Failures": JSON.stringify(failures).slice(0, 1000) } });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("ACS SELECTED PRINT ERROR", error);
    return Response.json({ success: false, message: error?.message || "Could not print selected labels." }, { status: 500 });
  }
}
