import { PDFDocument } from "pdf-lib";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  createOrReuseAcsLabel,
  parseCodAmountOverride,
  parseCodOverride,
  parsePickupDate,
} from "../services/acs-create-label.server";
import {
  extractPdfBytesFromAcsResponse,
  printAcsVoucher,
} from "../services/acs.server";

const BATCH_ERROR_TAG = "ACS_LABEL_ERROR";

function safeStr(value) {
  return String(value ?? "").trim();
}

function parseBatchPieces(value) {
  const text = safeStr(value);
  if (!/^\d+$/.test(text)) {
    throw new Error("Pieces must be a whole number greater than zero.");
  }
  const pieces = Number(text);
  if (!Number.isSafeInteger(pieces) || pieces < 1) {
    throw new Error("Pieces must be a whole number greater than zero.");
  }
  return pieces;
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    ...extra,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

function errorMessage(error) {
  return safeStr(error?.message) || "Unknown ACS error.";
}

async function addOrderTags(admin, orderId, tags) {
  const query = `#graphql
    mutation AddOrderTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }
  `;
  const response = await admin.graphql(query, {
    variables: { id: orderId, tags },
  });
  const json = await response.json();
  if (json?.errors?.length) {
    throw new Error(json.errors.map((item) => item.message).join(" | "));
  }
  const userErrors = json?.data?.tagsAdd?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors.map((item) => item.message).join(" | "));
  }
}

async function tagOrderWithBatchError(admin, orderId) {
  await addOrderTags(admin, orderId, [BATCH_ERROR_TAG]);
}

async function findExistingAcsLabels(admin, orders) {
  const response = await admin.graphql(`#graphql
    query ExistingAcsBatchLabels($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Order {
          id
          name
          voucher: metafield(namespace: "acs", key: "voucher_number") { value }
          url: metafield(namespace: "acs", key: "label_url") { value }
          pieces: metafield(namespace: "acs", key: "pieces") { value }
          pickupDate: metafield(namespace: "acs", key: "pickup_date") { value }
          numbers: metafield(namespace: "acs", key: "current_numbers") { value }
        }
      }
    }
  `, { variables: { ids: orders.map((order) => order.orderId) } });
  const json = await response.json();
  if (json?.errors?.length) throw new Error(json.errors.map((item) => item.message).join(" | "));

  const byId = new Map((json?.data?.nodes || []).filter(Boolean).map((order) => [order.id, order]));
  return orders.flatMap((order) => {
    const node = byId.get(order.orderId);
    const voucherNumber = safeStr(node?.voucher?.value);
    if (!voucherNumber) return [];
    let shipmentNumbers = [];
    try {
      const parsed = JSON.parse(node?.numbers?.value || "[]");
      if (Array.isArray(parsed)) shipmentNumbers = parsed.map(String);
    } catch {
      shipmentNumbers = [];
    }
    if (!shipmentNumbers.length) shipmentNumbers = [voucherNumber];
    return [{
      orderId: order.orderId,
      orderName: safeStr(node?.name) || order.orderName,
      voucherNumber,
      labelUrl: safeStr(node?.url?.value),
      pieces: safeStr(node?.pieces?.value) || "1",
      pickupDate: safeStr(node?.pickupDate?.value),
      shipmentNumbers,
    }];
  });
}

function encodeResults(results) {
  return Buffer.from(JSON.stringify(results), "utf8").toString("base64");
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  return jsonResponse(
    { success: false, message: "Use POST to generate ACS batch labels." },
    405,
  );
}

export async function action({ request }) {
  try {
    const { admin, session } = await authenticate.admin(request);
    const payload = await request.json();
    const inputOrders = Array.isArray(payload?.orders) ? payload.orders : [];
    const employeeId = safeStr(payload?.employeeId);

    if (!inputOrders.length) {
      return jsonResponse(
        { success: false, message: "No orders were selected." },
        400,
      );
    }

    if (!employeeId) {
      return jsonResponse(
        {
          success: false,
          message: "Select an employee before generating labels.",
        },
        400,
      );
    }

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, shop: session.shop },
      select: { name: true },
    });
    if (!employee) {
      return jsonResponse(
        { success: false, message: "The selected employee was not found." },
        400,
      );
    }
    const preparedBy = employee.name;

    const uniqueOrders = [];
    const seen = new Set();
    for (const order of inputOrders) {
      const orderId = safeStr(order?.orderId);
      if (!orderId || seen.has(orderId)) continue;
      seen.add(orderId);
      uniqueOrders.push({
        orderId,
        orderName: safeStr(order?.orderName) || orderId,
        pieces: parseBatchPieces(order?.pieces || "1"),
        pickupDate: order?.pickupDate,
        cod: order?.cod,
        codAmount: order?.codAmount,
        resolution: safeStr(order?.resolution),
      });
    }

    if (!uniqueOrders.length) {
      return jsonResponse(
        {
          success: false,
          message: "The selected orders did not contain valid order IDs.",
        },
        400,
      );
    }

    // Stop before creating or printing anything when an existing label needs
    // an explicit per-order choice. This prevents accidental duplicate prints.
    const existingLabels = await findExistingAcsLabels(admin, uniqueOrders);
    const existingById = new Map(existingLabels.map((item) => [item.orderId, item]));
    const unresolved = existingLabels.filter((item) => {
      const order = uniqueOrders.find((candidate) => candidate.orderId === item.orderId);
      return !["reprint", "skip", "new"].includes(order?.resolution);
    });
    if (unresolved.length) {
      return jsonResponse({ success: true, requiresResolution: true, existingOrders: unresolved });
    }

    const mergedPdf = await PDFDocument.create();
    const successes = [];
    const skipped = [];
    const errors = [];
    const tagWarnings = [];

    for (const order of uniqueOrders) {
      const existingLabel = existingById.get(order.orderId);
      if (existingLabel && order.resolution === "skip") {
        skipped.push({ orderId: order.orderId, orderName: order.orderName, reason: "Skipped by user" });
        continue;
      }
      if (preparedBy) {
        try {
          await addOrderTags(admin, order.orderId, [preparedBy]);
        } catch (tagError) {
          tagWarnings.push({
            orderId: order.orderId,
            orderName: order.orderName,
            message: errorMessage(tagError),
          });
        }
      }

      try {
        const pickupDate = parsePickupDate(order.pickupDate);
        const result = await createOrReuseAcsLabel({
          admin,
          orderGid: order.orderId,
          forceNew: order.resolution === "new",
          pieces: order.pieces,
          codOverride: parseCodOverride(order.cod),
          codAmountOverride: parseCodAmountOverride(order.codAmount),
          requestedContentTypeId: 7,
          requestedPickupDate: pickupDate,
        });

        const numbers =
          Array.isArray(result?.shipmentNumbers) &&
          result.shipmentNumbers.length
            ? result.shipmentNumbers.map(String)
            : result?.voucherNumber
              ? [String(result.voucherNumber)]
              : [];

        if (!numbers.length) {
          throw new Error(
            "ACS did not return a voucher number for this order.",
          );
        }

        // ACS prints the master voucher together with all multipart labels.
        // Printing each child number again duplicates the parcels in the PDF.
        const printVoucherNumber = String(result?.voucherNumber || numbers[0]);
        const printResponse = await printAcsVoucher(printVoucherNumber, {
          printType: 1,
          startPosition: 1,
        });
        const pdfBytes = extractPdfBytesFromAcsResponse(printResponse);
        if (!pdfBytes) {
          throw new Error(
            `ACS returned no printable PDF bytes for voucher ${printVoucherNumber}.`,
          );
        }
        const orderPdf = await PDFDocument.load(pdfBytes);

        const pages = await mergedPdf.copyPages(
          orderPdf,
          orderPdf.getPageIndices(),
        );
        pages.forEach((page) => mergedPdf.addPage(page));

        successes.push({
          orderId: order.orderId,
          orderName: order.orderName,
          pieces: String(order.pieces),
          pickupDate,
          printVoucherNumber,
          voucherNumbers: numbers,
        });
      } catch (error) {
        let message = errorMessage(error);
        let tagApplied = false;
        try {
          await tagOrderWithBatchError(admin, order.orderId);
          tagApplied = true;
        } catch (tagError) {
          message += ` (Could not add ${BATCH_ERROR_TAG} tag: ${errorMessage(tagError)})`;
        }

        errors.push({
          orderId: order.orderId,
          orderName: order.orderName,
          message,
          tag: BATCH_ERROR_TAG,
          tagApplied,
        });
      }
    }

    const results = {
      successes,
      skipped,
      errors,
      tagWarnings,
      preparedBy: preparedBy || null,
      errorTag: BATCH_ERROR_TAG,
    };
    if (mergedPdf.getPageCount() === 0) {
      if (skipped.length && !errors.length) {
        return jsonResponse({ success: true, results });
      }
      return jsonResponse({
        success: false,
        message: "No ACS labels could be generated.",
        results,
      });
    }

    const mergedBytes = await mergedPdf.save();
    return new Response(mergedBytes, {
      status: 200,
      headers: corsHeaders({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="acs-batch-${new Date().toISOString().slice(0, 10)}.pdf"`,
        "Cache-Control": "no-store",
        "Access-Control-Expose-Headers": "X-ACS-Batch-Results",
        "X-ACS-Batch-Results": encodeResults(results),
      }),
    });
  } catch (error) {
    console.error("ACS BATCH MERGE PDF ERROR:", error);
    return jsonResponse({ success: false, message: errorMessage(error) }, 500);
  }
}
