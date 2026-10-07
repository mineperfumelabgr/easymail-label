import { getAcsTrackingDetails, getAcsTrackingSummary, getAcsTableRows } from "./acs.server.js";
import prisma from "../db.server.js";

const ORDER_QUERY = `#graphql
  query OrdersForAcsTracking($after: String) {
    orders(first: 50, after: $after, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges { node {
          id name createdAt
        shippingAddress { name }
        tags
        metafield(namespace: "acs", key: "current_numbers") { value }
        fulfillments(first: 10) {
          id status displayStatus createdAt deliveredAt trackingInfo { company number }
          events(first: 20, sortKey: HAPPENED_AT, reverse: true) { edges { node { status happenedAt message } } }
        }
      } }
    }
  }
`;

const ACTIVE_ORDERS_QUERY = `#graphql
  query ActiveAcsOrdersById($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id name createdAt
        shippingAddress { name }
        tags
        metafield(namespace: "acs", key: "current_numbers") { value }
        fulfillments(first: 10) {
          id status displayStatus createdAt deliveredAt trackingInfo { company number }
          events(first: 20, sortKey: HAPPENED_AT, reverse: true) { edges { node { status happenedAt message } } }
        }
      }
    }
  }
`;

const CREATE_EVENT = `#graphql
  mutation CreateAcsTrackingEvent($event: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $event) {
      fulfillmentEvent { id status happenedAt message }
      userErrors { field message }
    }
  }
`;

const ADD_ORDER_TAG = `#graphql
  mutation AddAcsStatusTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

function normalizeText(value = "") {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
}

export function classifyAcsShipment(summary = {}, lastCheckpointAction = "") {
  const status = Number(summary.shipment_status);
  const reason = normalizeText(summary.non_delivery_reason_code);
  const checkpoint = normalizeText(lastCheckpointAction);
  if (Number(summary.returned_flag) === 1 && status === 7) return { status: "RETURNED", label: "Restituito al mittente" };
  if (Number(summary.returned_flag) === 1 || status === 6) return { status: "RETURNING", label: "In restituzione al mittente" };
  if (status === 4 && Number(summary.delivery_flag) === 1) return { status: "DELIVERED", label: "Consegnato al destinatario" };
  if (["ΑΔ1", "AD1", "ΑΔ8", "AD8"].includes(reason) || /ΑΝΑΜΟΝΗ ΓΙΑ ΠΑΡΑΛΑΒΗ|READY FOR PICKUP/.test(checkpoint)) return { status: "READY_FOR_PICKUP", label: "Da ritirare presso ACS" };
  if (["ΠΑ1", "ΠΑ2", "ΠΑ4", "PA1", "PA2", "PA4", "ΔΠ1", "DP1", "ΕΔ1", "ED1"].includes(reason)) return { status: "DELIVERY_DELAYED", label: "Consegna in ritardo o riprogrammata" };
  if (/ΠΡΟΣ ΠΑΡΑΔΟΣΗ|ΠΡΟΣ ΔΙΑΝΟΜΗ|OUT FOR DELIVERY|ΠΑΡΑΔΟΣΗ ΣΤΟΝ ΠΑΡΑΛΗΠΤΗ/.test(checkpoint)) return { status: "OUT_FOR_DELIVERY", label: "In consegna" };
  if (status === 3 || ["ΑΣ1", "AS1"].includes(reason)) return { status: "DELIVERY_ATTEMPTED", label: "Tentativo di consegna non riuscito" };
  if (["ΛΣ1", "LS1", "ΛΣ3", "LS3"].includes(reason)) return { status: "DELIVERY_DELAYED", label: "Verificare indirizzo o destinatario" };
  if (["ΑΠ1", "AP1", "ΑΠ2", "AP2", "ΑΠ3", "AP3", "ΑΠ4", "AP4"].includes(reason)) return { status: "DELIVERY_ATTEMPTED", label: "Problema rilevato durante la consegna" };
  if (status === 1) return { status: "DELIVERY_DELAYED", label: "Consegna non completata" };
  if (status === 2 || status === 5) return { status: "IN_TRANSIT", label: "Spedito / in transito" };
  if (status === 4) return { status: "IN_TRANSIT", label: "In verifica ACS" };
  return { status: "UNKNOWN", label: "Stato ACS da verificare" };
}

export function mapCheckpoint(action = "", summary = {}) {
  const text = normalizeText(action);
  if (/SMS|MESSAG|ΕΙΔΟΠΟΙΗΣ|ΕΚΤΥΠΩΣ|ΕΤΙΚΕΤ|VOUCHER|LABEL/.test(text)) return null;
  if (/^(?:ΠΑΡΑΔΟΣΗ|ΠΑΡΑΔΟΘΗΚΕ|DELIVERED)(?:\s|$)/.test(text)) {
    if (Number(summary.returned_flag) === 1) return null;
    return Number(summary.delivery_flag) === 1 && Number(summary.shipment_status) === 4 ? "DELIVERED" : null;
  }
  if (/ΠΡΟΣ ΠΑΡΑΔΟΣΗ|ΠΡΟΣ ΔΙΑΝΟΜΗ|OUT FOR DELIVERY|ΠΑΡΑΔΟΣΗ ΣΤΟΝ ΠΑΡΑΛΗΠΤΗ/.test(text)) return "OUT_FOR_DELIVERY";
  if (/ΑΠΩΝ|ΑΔΥΝΑΜΙΑ|ΑΡΝΗΣΗ|ΜΗ ΑΠΟΔΟΧΗ|ΑΓΝΩΣΤΟΣ ΠΑΡΑΛΗΠΤΗΣ|ATTEMPT|ΜΗ ΠΑΡΑΔΟΣΗ/.test(text)) return "ATTEMPTED_DELIVERY";
  if (/ΠΡΟΣ ΕΠΙΣΤΡΟΦΗ|ΕΠΙΣΤΡΟΦΗ|RETURN/.test(text)) return [6, 7].includes(Number(summary.shipment_status)) ? "FAILURE" : null;
  if (/ΑΝΑΜΟΝΗ ΓΙΑ ΠΑΡΑΛΑΒΗ|READY FOR PICKUP/.test(text) || (/ΑΦΙΞΗ ΣΕ ΚΑΤΑΣΤΗΜΑ/.test(text) && ["ΑΔ1", "AD1", "ΑΔ8", "AD8"].includes(normalizeText(summary.non_delivery_reason_code)))) return "READY_FOR_PICKUP";
  if (/ΠΑΡΑΛΑΒΗ ΑΠΟ ΑΠΟΣΤΟΛΕΑ|PICKED UP FROM SENDER|ΠΑΡΕΛΗΦΘΗ ΑΠΟ ΑΠΟΣΤΟΛΕΑ/.test(text)) return "CARRIER_PICKED_UP";
  const reason = normalizeText(summary.non_delivery_reason_code);
  if (["ΠΑ1", "ΠΑ2", "ΠΑ4", "PA1", "PA2", "PA4", "ΔΠ1", "DP1", "ΕΔ1", "ED1", "ΛΣ1", "LS1", "ΛΣ3", "LS3"].includes(reason)) return "DELAYED";
  if (/ΑΝΑΧΩΡΗΣΗ|ΑΦΙΞΗ|ΚΑΤΑΣΤΗΜΑ|ΔΙΑΚΙΝΗΣΗ|IN TRANSIT|TRANSIT|HUB|ΠΡΟΣ ΠΡΟΟΡΙΣΜΟ/.test(text)) return "IN_TRANSIT";
  return null;
}

function summaryEventStatus(status) {
  return {
    IN_TRANSIT: "IN_TRANSIT",
    READY_FOR_PICKUP: "READY_FOR_PICKUP",
    OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
    DELIVERY_ATTEMPTED: "ATTEMPTED_DELIVERY",
    DELIVERY_DELAYED: "DELAYED",
    RETURNING: "FAILURE",
    RETURNED: "FAILURE",
    DELIVERED: "DELIVERED",
  }[status] || null;
}

export function eventTime(value) {
  if (!value) return null;
  const s = String(value).trim();
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) {
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const [, y, mo, d, h, mi, sec, fraction = "0"] = match;
  const targetUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, Number(`0.${fraction}`) * 1000);
  let guess = targetUtc;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const represented = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess += targetUtc - represented;
  }
  return new Date(guess).toISOString();
}

async function graph(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

async function createShopifyEvent(admin, fulfillmentId, status, happenedAt, message, city) {
  const data = await graph(admin, CREATE_EVENT, { event: {
    fulfillmentId, status, happenedAt, message: String(message || "").slice(0, 255),
    ...(city ? { city } : {}), country: "GR",
  } });
  const payload = data.fulfillmentEventCreate;
  if (payload.userErrors?.length) throw new Error(payload.userErrors.map((e) => e.message).join("; "));
  return payload.fulfillmentEvent;
}

export async function runAcsTrackingSync(admin, shop) {
    const orders = [];
    let after = null;
    // Limit each run to the latest 250 orders to keep API calls bounded.
    for (let page = 0; page < 5; page++) {
      const data = await graph(admin, ORDER_QUERY, { after });
      const connection = data.orders;
      orders.push(...connection.edges.map((edge) => edge.node));
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }

    // Recent-order discovery is capped at 250 rows per run. Also reload every
    // previously tracked, non-delivered order by ID so an old open shipment is
    // not abandoned just because newer orders pushed it past that window.
    const knownOpenOrderRows = await prisma.acsTrackingSnapshot.findMany({
      where: { shop, orderId: { not: null }, status: { notIn: ["DELIVERED", "RETURNED", "ACS_REVIEW_REQUIRED"] } },
      select: { orderId: true },
      distinct: ["orderId"],
    });
    const knownOpenOrderIds = knownOpenOrderRows.map((row) => row.orderId).filter(Boolean);
    for (let i = 0; i < knownOpenOrderIds.length; i += 5) {
      const data = await graph(admin, ACTIVE_ORDERS_QUERY, { ids: knownOpenOrderIds.slice(i, i + 5) });
      orders.push(...(data.nodes || []).filter(Boolean));
    }
    const uniqueOrders = [...new Map(orders.map((order) => [order.id, order])).values()];
    orders.splice(0, orders.length, ...uniqueOrders);

    const result = { checked: 0, created: 0, skipped: 0, snapshots: 0, alerts: 0, tagsAdded: 0, tagErrors: [], errors: [] };
    const tagRules = await prisma.acsTrackingTagRule.findMany({ where: { shop, enabled: true } });
    const tagByStatus = new Map(tagRules.filter((rule) => rule.tag?.trim()).map((rule) => [rule.status, rule.tag.trim()]));
    async function addStatusTag(order, status, orderTags, voucher) {
      const statusTag = tagByStatus.get(status);
      if (!statusTag || orderTags.has(statusTag)) return;
      try {
        const tagData = await graph(admin, ADD_ORDER_TAG, { id: order.id, tags: [statusTag] });
        const tagErrors = tagData.tagsAdd.userErrors || [];
        if (tagErrors.length) throw new Error(tagErrors.map((item) => item.message).join("; "));
        orderTags.add(statusTag);
        result.tagsAdded++;
      } catch (tagError) {
        result.tagErrors.push({ order: order.name, voucher, tag: statusTag, message: tagError?.message || "Could not add ACS status tag" });
      }
    }
    for (const order of orders) {
      const acsFulfillments = (order.fulfillments || []).filter((fulfillment) =>
        fulfillment.status !== "CANCELLED" && (fulfillment.trackingInfo || []).some((tracking) => /ACS/i.test(tracking.company || "") && tracking.number)
      );
      let trackingEntries = acsFulfillments.flatMap((fulfillment) =>
        fulfillment.trackingInfo.filter((tracking) => /ACS/i.test(tracking.company || "") && tracking.number)
          .map((tracking) => ({ fulfillment, number: String(tracking.number) }))
      );
      trackingEntries = [...new Map(trackingEntries.map((entry) => [`${entry.fulfillment.id}:${entry.number}`, entry])).values()];
      if (!trackingEntries.length) {
        let fallbackNumbers = [];
        try { fallbackNumbers = JSON.parse(order.metafield?.value || "[]").map(String); } catch { /* Ignore malformed legacy metadata. */ }
        const fallbackFulfillment = (order.fulfillments || []).find((item) => item.status !== "CANCELLED");
        // The order metafield only represents the current label. Use it only when
        // Shopify has no ACS tracking number on any fulfillment to avoid pairing
        // a second parcel's voucher with the first parcel's fulfillment.
        if (fallbackFulfillment) trackingEntries = [...new Set(fallbackNumbers.filter(Boolean))].map((number) => ({ fulfillment: fallbackFulfillment, number }));
      }
      if (!trackingEntries.length) continue;
      const orderTags = new Set(order.tags || []);
      const packageStates = [];

      for (const { fulfillment, number } of trackingEntries) {
        result.checked++;
        let packageStatus = null;
        try {
          const oldSnapshot = await prisma.acsTrackingSnapshot.findUnique({ where: { shop_voucherNo: { shop, voucherNo: String(number) } } });
          const currentEvents = (fulfillment.events?.edges || []).map((edge) => edge.node);
          const voucherEvents = currentEvents.filter((event) => String(event.message || "").includes(`ACS ${number}:`))
            .sort((a, b) => new Date(a.happenedAt).getTime() - new Date(b.happenedAt).getTime());
          const latestVoucherEvent = voucherEvents.at(-1);
          if (oldSnapshot?.status === "DELIVERED") {
            if (oldSnapshot.lastShopifyEventStatus !== "DELIVERED" && latestVoucherEvent?.status !== "DELIVERED") {
              const happenedAt = oldSnapshot.lastEventAt?.toISOString?.() || new Date().toISOString();
              await createShopifyEvent(admin, fulfillment.id, "DELIVERED", happenedAt, `ACS ${number}: ACS confirms delivery to the recipient.`);
              result.created++;
            }
            await prisma.acsTrackingSnapshot.update({
              where: { shop_voucherNo: { shop, voucherNo: String(number) } },
              data: {
                orderCreatedAt: order.createdAt ? new Date(order.createdAt) : null,
                fulfillmentId: fulfillment.id,
                fulfillmentStatus: fulfillment.displayStatus || fulfillment.status || null,
                fulfillmentCreatedAt: fulfillment.createdAt ? new Date(fulfillment.createdAt) : null,
                fulfillmentDeliveredAt: fulfillment.deliveredAt ? new Date(fulfillment.deliveredAt) : null,
                lastShopifyEventStatus: "DELIVERED",
                lastCheckedAt: new Date(),
              },
            });
            packageStates.push({ number, status: oldSnapshot.status });
            result.skipped++;
            continue;
          }
          if (oldSnapshot?.status === "RETURNED" && currentEvents.some((event) => event.status === "FAILURE" && /RESTITUITO AL MITTENTE/.test(event.message || ""))) {
            await prisma.acsTrackingSnapshot.update({
              where: { shop_voucherNo: { shop, voucherNo: String(number) } },
              data: {
                orderCreatedAt: order.createdAt ? new Date(order.createdAt) : null,
                fulfillmentId: fulfillment.id,
                fulfillmentStatus: fulfillment.displayStatus || fulfillment.status || null,
                fulfillmentCreatedAt: fulfillment.createdAt ? new Date(fulfillment.createdAt) : null,
                fulfillmentDeliveredAt: fulfillment.deliveredAt ? new Date(fulfillment.deliveredAt) : null,
                lastCheckedAt: new Date(),
              },
            });
            packageStates.push({ number, status: oldSnapshot.status });
            result.skipped++;
            continue;
          }
          const ageAnchor = fulfillment.createdAt || oldSnapshot?.fulfillmentCreatedAt || order.createdAt || oldSnapshot?.orderCreatedAt;
          const isOlderThanReviewCutoff = ageAnchor && Number.isFinite(new Date(ageAnchor).getTime())
            && Date.now() - new Date(ageAnchor).getTime() >= 90 * 24 * 60 * 60 * 1000;
          if (isOlderThanReviewCutoff && oldSnapshot?.status !== "RETURNED") {
            // Old unresolved shipments move to a manual-review state. Do not
            // query ACS or emit Shopify events/tags for an unverified outcome.
            const reviewSnapshot = {
              shop, orderId: order.id, orderName: order.name,
              orderCreatedAt: order.createdAt ? new Date(order.createdAt) : oldSnapshot?.orderCreatedAt || null,
              fulfillmentId: fulfillment.id,
              fulfillmentStatus: fulfillment.displayStatus || fulfillment.status || oldSnapshot?.fulfillmentStatus || null,
              fulfillmentCreatedAt: fulfillment.createdAt ? new Date(fulfillment.createdAt) : oldSnapshot?.fulfillmentCreatedAt || null,
              fulfillmentDeliveredAt: fulfillment.deliveredAt ? new Date(fulfillment.deliveredAt) : oldSnapshot?.fulfillmentDeliveredAt || null,
              voucherNo: String(number), recipientName: order.shippingAddress?.name || oldSnapshot?.recipientName || null,
              status: "ACS_REVIEW_REQUIRED", statusLabel: "Older than 90 days; manual ACS review required",
              shipmentStatus: oldSnapshot?.shipmentStatus ?? null, deliveryFlag: oldSnapshot?.deliveryFlag ?? 0,
              returnedFlag: oldSnapshot?.returnedFlag ?? 0, reasonCode: oldSnapshot?.reasonCode || null,
              lastCheckpoint: oldSnapshot?.lastCheckpoint || null, lastLocation: oldSnapshot?.lastLocation || null,
              lastEventAt: oldSnapshot?.lastEventAt || null, lastCheckedAt: new Date(), error: null,
            };
            await prisma.acsTrackingSnapshot.upsert({
              where: { shop_voucherNo: { shop, voucherNo: String(number) } },
              create: reviewSnapshot,
              update: { ...reviewSnapshot, lastShopifyEventStatus: oldSnapshot?.lastShopifyEventStatus || null, lastShopifyCheckpointAt: oldSnapshot?.lastShopifyCheckpointAt || null },
            });
            packageStatus = "ACS_REVIEW_REQUIRED";
            packageStates.push({ number, status: packageStatus });
            result.skipped++;
            continue;
          }
          const summary = getAcsTableRows(await getAcsTrackingSummary(number))[0];
          if (!summary) {
            // Shopify already has an active ACS fulfillment: until ACS has its first
            // scan, this is a newly created label, not a failed delivery or sync error.
            const waitingSnapshot = {
              shop, orderId: order.id, orderName: order.name, orderCreatedAt: order.createdAt ? new Date(order.createdAt) : null, fulfillmentId: fulfillment.id,
              fulfillmentStatus: fulfillment.displayStatus || fulfillment.status || null,
              fulfillmentCreatedAt: fulfillment.createdAt ? new Date(fulfillment.createdAt) : null,
              fulfillmentDeliveredAt: fulfillment.deliveredAt ? new Date(fulfillment.deliveredAt) : null,
              voucherNo: String(number), recipientName: order.shippingAddress?.name || null,
              status: "LABEL_CREATED", statusLabel: "Label created; awaiting ACS pickup",
              shipmentStatus: null, deliveryFlag: 0, returnedFlag: 0, reasonCode: null,
              lastCheckpoint: null, lastLocation: null, lastEventAt: null,
              lastCheckedAt: new Date(), error: null,
            };
            await prisma.acsTrackingSnapshot.upsert({
              where: { shop_voucherNo: { shop, voucherNo: String(number) } },
              create: waitingSnapshot,
              update: { ...waitingSnapshot, status: oldSnapshot?.status && !["SYNC_ERROR", "LABEL_CREATED"].includes(oldSnapshot.status) ? oldSnapshot.status : "LABEL_CREATED", statusLabel: oldSnapshot?.status && !["SYNC_ERROR", "LABEL_CREATED"].includes(oldSnapshot.status) ? oldSnapshot.statusLabel : waitingSnapshot.statusLabel },
            });
            const isAwaitingFirstScan = !oldSnapshot || ["SYNC_ERROR", "LABEL_CREATED"].includes(oldSnapshot.status);
            if (isAwaitingFirstScan && oldSnapshot?.lastShopifyEventStatus !== "LABEL_PRINTED" && latestVoucherEvent?.status !== "LABEL_PRINTED") {
              await createShopifyEvent(admin, fulfillment.id, "LABEL_PRINTED", fulfillment.createdAt || new Date().toISOString(), `ACS ${number}: ACS label created; awaiting carrier pickup.`);
              result.created++;
              await prisma.acsTrackingSnapshot.update({ where: { shop_voucherNo: { shop, voucherNo: String(number) } }, data: { lastShopifyEventStatus: "LABEL_PRINTED" } });
            }
            result.snapshots++;
            packageStatus = oldSnapshot?.status && !["SYNC_ERROR", "LABEL_CREATED"].includes(oldSnapshot.status) ? oldSnapshot.status : "LABEL_CREATED";
            packageStates.push({ number, status: packageStatus });
            continue;
          }
          const details = getAcsTableRows(await getAcsTrackingDetails(number));
          const checkpoints = [...details].sort((a, b) => String(a.checkpoint_date_time).localeCompare(String(b.checkpoint_date_time)));
          const lastCheckpoint = [...checkpoints].reverse().find((item) => !/SMS|MESSAG|ΕΙΔΟΠΟΙΗΣ|ΕΚΤΥΠΩΣ|ΕΤΙΚΕΤ|VOUCHER|LABEL/i.test(item.checkpoint_action || ""));
          const classified = classifyAcsShipment(summary, lastCheckpoint?.checkpoint_action || "");
          const snapshot = {
            shop,
            orderId: order.id,
            orderName: order.name,
            orderCreatedAt: order.createdAt ? new Date(order.createdAt) : null,
            fulfillmentId: fulfillment.id,
            fulfillmentStatus: fulfillment.displayStatus || fulfillment.status || null,
            fulfillmentCreatedAt: fulfillment.createdAt ? new Date(fulfillment.createdAt) : null,
            fulfillmentDeliveredAt: fulfillment.deliveredAt ? new Date(fulfillment.deliveredAt) : null,
            voucherNo: String(number),
            recipientName: order.shippingAddress?.name || null,
            status: classified.status,
            statusLabel: classified.label,
            shipmentStatus: Number(summary.shipment_status) || null,
            deliveryFlag: Number(summary.delivery_flag) || 0,
            returnedFlag: Number(summary.returned_flag) || 0,
            reasonCode: summary.non_delivery_reason_code || null,
            lastCheckpoint: lastCheckpoint?.checkpoint_action || null,
            lastLocation: lastCheckpoint?.checkpoint_location || null,
            lastEventAt: eventTime(lastCheckpoint?.checkpoint_date_time),
            lastCheckedAt: new Date(),
            error: null,
          };
          await prisma.acsTrackingSnapshot.upsert({
            where: { shop_voucherNo: { shop, voucherNo: String(number) } },
            create: snapshot,
            update: {
              ...snapshot,
              lastShopifyEventStatus: oldSnapshot?.lastShopifyEventStatus || null,
              lastShopifyCheckpointAt: oldSnapshot?.lastShopifyCheckpointAt || null,
            },
          });
          result.snapshots++;
          if (["DELIVERY_PROBLEM", "DELIVERY_ATTEMPTED", "DELIVERY_DELAYED", "RETURNING", "RETURNED"].includes(classified.status)) result.alerts++;
          packageStatus = classified.status;

          const summaryStatus = summaryEventStatus(classified.status);
          const checkpointStatus = mapCheckpoint(lastCheckpoint?.checkpoint_action, summary);
          const specificCheckpointStatuses = ["CARRIER_PICKED_UP", "READY_FOR_PICKUP", "OUT_FOR_DELIVERY", "ATTEMPTED_DELIVERY", "DELAYED"];
          const finalStatus = ["DELIVERED", "RETURNING", "RETURNED"].includes(classified.status)
            ? summaryStatus
            : (specificCheckpointStatuses.includes(checkpointStatus) ? checkpointStatus : summaryStatus);
          const latestCheckpointAt = eventTime(lastCheckpoint?.checkpoint_date_time);
          const summaryEventAt = ["RETURNING", "RETURNED"].includes(classified.status)
            ? (latestCheckpointAt || eventTime(summary.delivery_date) || new Date().toISOString())
            : (eventTime(summary.delivery_date) || latestCheckpointAt || new Date().toISOString());
          const where = { shop_voucherNo: { shop, voucherNo: String(number) } };
          let lastSentStatus = oldSnapshot?.lastShopifyEventStatus || latestVoucherEvent?.status || null;
          const previousCursor = oldSnapshot?.lastShopifyCheckpointAt || null;
          const newCheckpoints = previousCursor
            ? checkpoints.filter((item) => {
                const at = eventTime(item.checkpoint_date_time);
                return at && new Date(at) > previousCursor;
              })
            : [];
          for (const checkpoint of newCheckpoints) {
            const status = mapCheckpoint(checkpoint.checkpoint_action, summary);
            const happenedAt = eventTime(checkpoint.checkpoint_date_time);
            if (!status || !happenedAt || status === lastSentStatus) { result.skipped++; continue; }
            const detailMessage = [checkpoint.checkpoint_action, checkpoint.checkpoint_notes, checkpoint.checkpoint_location]
              .map((v) => String(v || "").trim()).filter(Boolean).join(" · ");
            await createShopifyEvent(admin, fulfillment.id, status, happenedAt, `ACS ${number}: ${detailMessage || classified.label}`, checkpoint.checkpoint_location);
            result.created++;
            lastSentStatus = status;
            await prisma.acsTrackingSnapshot.update({ where, data: { lastShopifyEventStatus: status } });
          }
          // On the first sync after installing this version, do not replay the
          // full ACS checkpoint history. The saved state or latest old Shopify
          // event seeds the current state; only new checkpoints are replayed.
          if (finalStatus && finalStatus !== lastSentStatus) {
            const isTerminalReturn = classified.status === "RETURNING" || classified.status === "RETURNED";
            const stateMessage = classified.status === "DELIVERED"
              ? "ACS confirms delivery to the recipient."
              : isTerminalReturn
                ? `ACS confirms return to sender: ${classified.label}.`
                : `ACS shipment state: ${classified.label}${snapshot.reasonCode ? ` (${snapshot.reasonCode})` : ""}.`;
            await createShopifyEvent(admin, fulfillment.id, finalStatus, summaryEventAt, `ACS ${number}: ${stateMessage}`, lastCheckpoint?.checkpoint_location);
            result.created++;
            lastSentStatus = finalStatus;
          } else {
            result.skipped++;
          }
          // Persist the checkpoint cursor even when every new checkpoint mapped
          // to the state already sent. This prevents the next cron from replaying
          // those same scans while still allowing later state transitions.
          await prisma.acsTrackingSnapshot.update({
            where,
            data: {
              ...(lastSentStatus ? { lastShopifyEventStatus: lastSentStatus } : {}),
              ...(latestCheckpointAt ? { lastShopifyCheckpointAt: new Date(latestCheckpointAt) } : {}),
            },
          });
        } catch (error) {
          let previousStatus = null;
          try {
            const message = error?.message || "Errore ACS/Shopify";
            const where = { shop_voucherNo: { shop, voucherNo: String(number) } };
            const oldSnapshot = await prisma.acsTrackingSnapshot.findUnique({ where });
            previousStatus = oldSnapshot?.status && oldSnapshot.status !== "SYNC_ERROR" ? oldSnapshot.status : null;
            await prisma.acsTrackingSnapshot.upsert({
              where,
              create: {
                shop, orderId: order.id, orderName: order.name, orderCreatedAt: order.createdAt ? new Date(order.createdAt) : null, fulfillmentId: fulfillment.id,
                fulfillmentStatus: fulfillment.displayStatus || fulfillment.status || null,
                fulfillmentCreatedAt: fulfillment.createdAt ? new Date(fulfillment.createdAt) : null,
                fulfillmentDeliveredAt: fulfillment.deliveredAt ? new Date(fulfillment.deliveredAt) : null,
                voucherNo: String(number), recipientName: order.shippingAddress?.name || null,
                status: "SYNC_ERROR", statusLabel: "Errore di aggiornamento", error: message,
              },
              update: {
                ...(oldSnapshot ? {} : { status: "SYNC_ERROR", statusLabel: "Errore di aggiornamento" }),
                orderCreatedAt: order.createdAt ? new Date(order.createdAt) : oldSnapshot?.orderCreatedAt || null,
                fulfillmentStatus: fulfillment.displayStatus || fulfillment.status || oldSnapshot?.fulfillmentStatus || null,
                fulfillmentCreatedAt: fulfillment.createdAt ? new Date(fulfillment.createdAt) : oldSnapshot?.fulfillmentCreatedAt || null,
                fulfillmentDeliveredAt: fulfillment.deliveredAt ? new Date(fulfillment.deliveredAt) : oldSnapshot?.fulfillmentDeliveredAt || null,
                error: message,
                lastCheckedAt: new Date(),
              },
            });
          } catch (dbError) {
            console.error("ACS TRACKING SNAPSHOT ERROR:", dbError);
          }
          packageStatus = previousStatus;
          result.errors.push({ order: order.name, voucher: number, message: error?.message || "Errore ACS/Shopify" });
        }
        packageStates.push({ number, status: packageStatus });
      }

      // Order-level tags: an issue or return is relevant when any parcel is
      // affected; delivery is final only when every active ACS parcel is delivered.
      const observedStatuses = new Set(packageStates.map((item) => item.status).filter(Boolean));
      for (const status of tagByStatus.keys()) {
        const matches = status === "DELIVERED"
          ? packageStates.length === trackingEntries.length && packageStates.length > 0 && packageStates.every((item) => item.status === "DELIVERED")
          : observedStatuses.has(status);
        if (matches) await addStatusTag(order, status, orderTags, packageStates.map((item) => item.number).join(", "));
      }
    }
    return result;
}
