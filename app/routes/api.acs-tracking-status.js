import { timingSafeEqual } from "node:crypto";
import prisma from "../db.server.js";
import { getAcsTableRows, getAcsTrackingDetails, getAcsTrackingSummary } from "../services/acs.server.js";
import { classifyAcsShipment, eventTime } from "../services/acs-tracking-sync.server.js";

const FRESHNESS_DEFAULT = 30;
const CUSTOMER_SUMMARIES = {
  IN_TRANSIT: "The shipment is currently in transit.",
  OUT_FOR_DELIVERY: "The shipment is currently out for delivery.",
  READY_FOR_PICKUP: "The shipment is ready for pickup at ACS.",
  DELIVERY_ATTEMPTED: "ACS reports an unsuccessful delivery attempt.",
  DELIVERY_DELAYED: "ACS reports that the delivery has been delayed or rescheduled.",
  DELIVERY_PROBLEM: "ACS reports a delivery issue that may require attention.",
  RETURNING: "The shipment is being returned to the sender.",
  RETURNED: "The shipment has been returned to the sender.",
  DELIVERED: "ACS confirms that the shipment was delivered to the recipient.",
  UNKNOWN: "The current ACS shipment status could not be determined.",
};
const LABELS = {
  IN_TRANSIT: "In transit", OUT_FOR_DELIVERY: "Out for delivery", READY_FOR_PICKUP: "Ready for pickup",
  DELIVERY_ATTEMPTED: "Delivery attempted", DELIVERY_DELAYED: "Delivery delayed", DELIVERY_PROBLEM: "Delivery problem",
  RETURNING: "Returning to sender", RETURNED: "Returned to sender", DELIVERED: "Delivered", UNKNOWN: "Unknown",
};
const normalize = (text) => String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
const ignoredCheckpoint = /SMS|MESSAG|ΕΙΔΟΠΟΙΗΣ|ΕΚΤΥΠΩΣ|ΕΤΙΚΕΤ|VOUCHER|LABEL/i;
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
function secretMatches(header, secret) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  if (!match || !secret) return false;
  const a = Buffer.from(match[1]); const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
function freshnessMinutes(raw) {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10080 ? parsed : FRESHNESS_DEFAULT;
}
function ageOf(date) { return Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000)); }
function publicStatus(snapshot) { return snapshot.status === "LABEL_CREATED" || snapshot.status === "SYNC_ERROR" ? "UNKNOWN" : snapshot.status; }
function responseFrom(snapshot, { source, ageMinutes, fresh, error = null }) {
  const status = publicStatus(snapshot);
  return {
    success: true, voucher: snapshot.voucherNo, source, fresh, age_minutes: ageMinutes,
    status, status_label: snapshot.status === "LABEL_CREATED" ? "Label created; awaiting ACS pickup" : (LABELS[status] || "Unknown"),
    reason_code: snapshot.reasonCode || null, last_checkpoint: snapshot.lastCheckpoint || null,
    last_location: snapshot.lastLocation || null, last_event_at: snapshot.lastEventAt?.toISOString?.() || null,
    last_checked_at: snapshot.lastCheckedAt.toISOString(), customer_safe_summary: CUSTOMER_SUMMARIES[status],
    error, order_name: snapshot.orderName || null, recipient_name: snapshot.recipientName || null,
    shipment_status: snapshot.shipmentStatus, delivery_flag: snapshot.deliveryFlag, returned_flag: snapshot.returnedFlag,
  };
}

export async function loader({ request }) {
  const secret = process.env.N8N_ACS_READ_SECRET;
  if (!secretMatches(request.headers.get("authorization"), secret)) return json({ success: false, code: "UNAUTHORIZED", message: "Unauthorized" }, 401);
  const shop = String(process.env.N8N_ACS_SHOP || "").trim().toLowerCase();
  if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return json({ success: false, code: "TRACKING_UNAVAILABLE", message: "Tracking information is currently unavailable." }, 503);
  const url = new URL(request.url);
  const voucher = String(url.searchParams.get("voucher") || "").trim();
  if (!/^\d{6,20}$/.test(voucher)) return json({ success: false, code: "INVALID_VOUCHER", message: "A valid voucher number is required." }, 400);
  const freshness = freshnessMinutes(url.searchParams.get("freshness_minutes"));
  const where = { shop, voucherNo: voucher };
  let existing = await prisma.acsTrackingSnapshot.findUnique({ where: { shop_voucherNo: where } });
  if (existing) {
    const age = ageOf(existing.lastCheckedAt);
    if (age < freshness && !existing.error && existing.status !== "SYNC_ERROR") return json(responseFrom(existing, { source: "snapshot", ageMinutes: age, fresh: true }));
  }
  try {
    const summary = getAcsTableRows(await getAcsTrackingSummary(voucher))[0];
    const detailRows = getAcsTableRows(await getAcsTrackingDetails(voucher));
    if (!summary) throw new Error("ACS tracking summary unavailable");
    const checkpoints = detailRows.filter((row) => !ignoredCheckpoint.test(row.checkpoint_action || ""))
      .sort((a, b) => String(a.checkpoint_date_time || "").localeCompare(String(b.checkpoint_date_time || "")));
    const last = checkpoints.at(-1) || null;
    const classified = classifyAcsShipment(summary, last?.checkpoint_action || "");
    const isLabelPending = !last && !summary.shipment_status && !summary.delivery_flag && !summary.returned_flag;
    const now = new Date();
    const record = {
      shop, orderId: existing?.orderId || null, orderName: existing?.orderName || null,
      fulfillmentId: existing?.fulfillmentId || null, fulfillmentStatus: existing?.fulfillmentStatus || null,
      fulfillmentCreatedAt: existing?.fulfillmentCreatedAt || null, fulfillmentDeliveredAt: existing?.fulfillmentDeliveredAt || null,
      voucherNo: voucher, recipientName: existing?.recipientName || null,
      status: isLabelPending ? "LABEL_CREATED" : classified.status,
      statusLabel: isLabelPending ? "Label created; awaiting ACS pickup" : classified.label,
      shipmentStatus: Number(summary.shipment_status) || null, deliveryFlag: Number(summary.delivery_flag) || 0,
      returnedFlag: Number(summary.returned_flag) || 0, reasonCode: summary.non_delivery_reason_code || null,
      lastCheckpoint: last?.checkpoint_action || null, lastLocation: last?.checkpoint_location || null,
      lastEventAt: eventTime(last?.checkpoint_date_time), lastCheckedAt: now, error: null,
    };
    const snapshot = await prisma.acsTrackingSnapshot.upsert({ where: { shop_voucherNo: where }, create: record, update: record });
    return json(responseFrom(snapshot, { source: "acs_refresh", ageMinutes: 0, fresh: true }));
  } catch (error) {
    console.error("N8N ACS TRACKING REFRESH ERROR", { voucher, shop, message: error?.message });
    if (existing) {
      await prisma.acsTrackingSnapshot.update({ where: { shop_voucherNo: where }, data: { lastCheckedAt: new Date(), error: "ACS refresh failed" } }).catch(() => {});
      return json({ success: false, voucher, code: "TRACKING_UNAVAILABLE", message: "Tracking information is currently unavailable.", source: "snapshot", fresh: false, age_minutes: ageOf(existing.lastCheckedAt), status: publicStatus(existing), status_label: existing.status === "LABEL_CREATED" ? "Label created; awaiting ACS pickup" : (LABELS[publicStatus(existing)] || "Unknown"), customer_safe_summary: CUSTOMER_SUMMARIES[publicStatus(existing)], error: "ACS refresh failed" });
    }
    return json({ success: false, voucher, code: "ACS_ERROR", message: "Tracking information is currently unavailable." }, 502);
  }
}

export async function action() {
  return json({ success: false, code: "METHOD_NOT_ALLOWED", message: "Use GET." }, 405);
}
