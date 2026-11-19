import {authenticate} from "../shopify.server";
import prisma from "../db.server";
const STATES = [
  ["IN_TRANSIT", "In transit"],
  ["OUT_FOR_DELIVERY", "Out for delivery"],
  ["READY_FOR_PICKUP", "Ready for pickup at ACS"],
  ["DELIVERY_ATTEMPTED", "Delivery attempted"],
  ["DELIVERY_DELAYED", "Delivery delayed"],
  ["DELIVERY_PROBLEM", "Delivery problem"],
  ["RETURNING", "Returning to sender"],
  ["RETURNED", "Returned to sender"],
  ["DELIVERED", "Delivered"],
  ["UNKNOWN", "Unknown status"],
];
const STATE_KEYS = new Set(STATES.map(([key]) => key));

export async function loadAcsTagSettings({ request }) {
  const { session } = await authenticate.admin(request);
  const saved = await prisma.acsTrackingTagRule.findMany({ where: { shop: session.shop } });
  const savedByState = new Map(saved.map((rule) => [rule.status, rule]));
  return {
    shop: session.shop,
    rules: STATES.map(([status, label]) => {
      const rule = savedByState.get(status);
      return { status, label, enabled: Boolean(rule?.enabled), tag: rule?.tag || "" };
    }),
  };
}

export async function handleAcsTagSettings({ request }) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  let submitted;
  try {
    submitted = JSON.parse(String(form.get("rules") || "[]"));
  } catch {
    return Response.json({ success: false, message: "Invalid tag settings." }, { status: 400 });
  }
  if (!Array.isArray(submitted) || submitted.length !== STATES.length) {
    return Response.json({ success: false, message: "One or more ACS statuses are missing." }, { status: 400 });
  }
  const rules = [];
  const seenStates = new Set();
  const seenTags = new Set();
  for (const item of submitted) {
    const status = String(item?.status || "");
    if (!STATE_KEYS.has(status) || seenStates.has(status)) {
      return Response.json({ success: false, message: "Invalid or duplicated ACS status." }, { status: 400 });
    }
    seenStates.add(status);
    const enabled = item.enabled === true;
    const tag = String(item.tag || "").trim();
    if (enabled && (!tag || tag.length > 80 || /[,\r\n]/.test(tag))) {
      return Response.json({ success: false, message: "Each active rule needs a valid Shopify tag (up to 80 characters)." }, { status: 400 });
    }
    if (enabled) {
      const normalizedTag = tag.toLocaleLowerCase();
      if (seenTags.has(normalizedTag)) {
        return Response.json({ success: false, message: "Use a different tag for each active status so Shopify Flow can distinguish transitions." }, { status: 400 });
      }
      seenTags.add(normalizedTag);
    }
    rules.push({ status, enabled, tag: tag || null });
  }

  await prisma.$transaction(rules.map((rule) => prisma.acsTrackingTagRule.upsert({
    where: { shop_status: { shop: session.shop, status: rule.status } },
    create: { shop: session.shop, ...rule },
    update: { enabled: rule.enabled, tag: rule.tag },
  })));
  return Response.json({ success: true, message: "Order tag settings saved." });
}

