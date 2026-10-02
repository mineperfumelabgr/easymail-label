import { getAcsTrackingDetails, getAcsTrackingSummary, getAcsTableRows } from "./acs.server.js";
import prisma from "../db.server.js";

const ORDER_QUERY = `#graphql
  query OrdersForAcsTracking($after: String) {
    orders(first: 50, after: $after, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id name
        shippingAddress { name }
        metafield(namespace: "acs", key: "current_numbers") { value }
        fulfillments(first: 10) {
          id status trackingInfo { company number }
          events(first: 100) { edges { node { status happenedAt message } } }
        }
      } }
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
  if (reason === "ΑΔ1" || reason === "AD1") return { status: "READY_FOR_PICKUP", label: "Da ritirare presso ACS" };
  if (["ΔΠ1", "DP1", "ΕΔ1", "ED1"].includes(reason)) return { status: "DELIVERY_PROBLEM", label: "Problema di consegna" };
  if (["ΠΑ1", "ΠΑ2", "ΠΑ4", "PA1", "PA2", "PA4"].includes(reason)) return { status: "DELIVERY_DELAYED", label: "Consegna riprogrammata" };
  if (status === 5 && /ΠΡΟΣ ΠΑΡΑΔΟΣΗ|ΠΡΟΣ ΔΙΑΝΟΜΗ|OUT FOR DELIVERY|ΠΑΡΑΔΟΣΗ ΣΤΟΝ ΠΑΡΑΛΗΠΤΗ/.test(checkpoint)) return { status: "OUT_FOR_DELIVERY", label: "In consegna" };
  if (status === 1 || status === 2) return { status: "DELIVERY_PROBLEM", label: "Problema di consegna" };
  if (status === 3) return { status: "DELIVERY_ATTEMPTED", label: "Tentativo di consegna non riuscito" };
  if (status === 5) return { status: "IN_TRANSIT", label: "Spedito / in transito" };
  if (status === 4) return { status: "IN_TRANSIT", label: "In verifica ACS" };
  return { status: "UNKNOWN", label: "Stato ACS da verificare" };
}

export function mapCheckpoint(action = "", summary = {}) {
  const text = normalizeText(action);
  if (/SMS|MESSAG|ΕΙΔΟΠΟΙΗΣ|ΕΚΤΥΠΩΣ|ΕΤΙΚΕΤ|VOUCHER|LABEL/.test(text)) return null;
  if (/^(?:ΠΑΡΑΔΟΣΗ|ΠΑΡΑΔΟΘΗΚΕ|DELIVERED)(?:\s|$)/.test(text)) {
    if (Number(summary.returned_flag) === 1) return "FAILURE";
    return Number(summary.delivery_flag) === 1 && Number(summary.shipment_status) === 4 ? "DELIVERED" : null;
  }
  if (/ΠΡΟΣ ΠΑΡΑΔΟΣΗ|ΠΡΟΣ ΔΙΑΝΟΜΗ|OUT FOR DELIVERY|ΠΑΡΑΔΟΣΗ ΣΤΟΝ ΠΑΡΑΛΗΠΤΗ/.test(text)) return "OUT_FOR_DELIVERY";
  if (/ΑΠΩΝ|ΑΔΥΝΑΜΙΑ|ΑΡΝΗΣΗ|ΜΗ ΑΠΟΔΟΧΗ|ΑΓΝΩΣΤΟΣ ΠΑΡΑΛΗΠΤΗΣ|ATTEMPT|ΜΗ ΠΑΡΑΔΟΣΗ/.test(text)) return "ATTEMPTED_DELIVERY";
  if (/ΠΡΟΣ ΕΠΙΣΤΡΟΦΗ|ΕΠΙΣΤΡΟΦΗ|RETURN/.test(text)) return "FAILURE";
  if (/ΑΦΙΞΗ ΣΕ ΚΑΤΑΣΤΗΜΑ|ΑΝΑΜΟΝΗ ΓΙΑ ΠΑΡΑΛΑΒΗ/.test(text) && ["ΑΔ1", "AD1"].includes(normalizeText(summary.non_delivery_reason_code))) return "READY_FOR_PICKUP";
  if (/ΠΑΡΑΛΑΒΗ ΑΠΟ ΑΠΟΣΤΟΛΕΑ|ΑΝΑΧΩΡΗΣΗ|ΑΦΙΞΗ|ΚΑΤΑΣΤΗΜΑ|ΔΙΑΚΙΝΗΣΗ|IN TRANSIT|PICKUP/.test(text)) return "IN_TRANSIT";
  return text ? "IN_TRANSIT" : null;
}

function summaryEventStatus(status) {
  return {
    IN_TRANSIT: "IN_TRANSIT",
    READY_FOR_PICKUP: "READY_FOR_PICKUP",
    OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
    DELIVERY_ATTEMPTED: "ATTEMPTED_DELIVERY",
    DELIVERY_DELAYED: "DELAYED",
    DELIVERY_PROBLEM: "FAILURE",
    RETURNING: "FAILURE",
    RETURNED: "FAILURE",
    DELIVERED: "DELIVERED",
  }[status] || null;
}

function eventTime(value) {
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

    const result = { checked: 0, created: 0, skipped: 0, snapshots: 0, alerts: 0, errors: [] };
    for (const order of orders) {
      const fulfillment = (order.fulfillments || []).find((f) =>
        (f.trackingInfo || []).some((t) => /ACS/i.test(t.company || ""))
      );
      if (!fulfillment || fulfillment.status === "CANCELLED") continue;
      let numbers = [];
      try {
        numbers = JSON.parse(order.metafield?.value || "[]").map(String);
      } catch {
        // Fall back to tracking numbers stored directly on the fulfillment.
      }
      if (!numbers.length) numbers = (fulfillment.trackingInfo || []).map((t) => t.number).filter(Boolean);
      if (!numbers.length) continue;

      for (const number of numbers) {
        result.checked++;
        try {
          const oldSnapshot = await prisma.acsTrackingSnapshot.findUnique({ where: { shop_voucherNo: { shop, voucherNo: String(number) } } });
          const currentEvents = (fulfillment.events?.edges || []).map((edge) => edge.node);
          if (oldSnapshot?.status === "DELIVERED" && currentEvents.some((event) => event.status === "DELIVERED")) { result.skipped++; continue; }
          if (oldSnapshot?.status === "RETURNED" && currentEvents.some((event) => event.status === "FAILURE" && /RESTITUITO AL MITTENTE/.test(event.message || ""))) { result.skipped++; continue; }
          const summary = getAcsTableRows(await getAcsTrackingSummary(number))[0];
          if (!summary) throw new Error("ACS non ha restituito lo stato riepilogativo.");
          const details = getAcsTableRows(await getAcsTrackingDetails(number));
          const checkpoints = [...details].sort((a, b) => String(a.checkpoint_date_time).localeCompare(String(b.checkpoint_date_time)));
          const lastCheckpoint = [...checkpoints].reverse().find((item) => !/SMS|MESSAG|ΕΙΔΟΠΟΙΗΣ|ΕΚΤΥΠΩΣ|ΕΤΙΚΕΤ|VOUCHER|LABEL/i.test(item.checkpoint_action || ""));
          const classified = classifyAcsShipment(summary, lastCheckpoint?.checkpoint_action || "");
          const snapshot = {
            shop,
            orderId: order.id,
            orderName: order.name,
            fulfillmentId: fulfillment.id,
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
            update: snapshot,
          });
          result.snapshots++;
          if (["DELIVERY_PROBLEM", "DELIVERY_ATTEMPTED", "DELIVERY_DELAYED", "RETURNING", "RETURNED"].includes(classified.status)) result.alerts++;

          const existing = (fulfillment.events?.edges || []).map((edge) => edge.node);
          for (const checkpoint of details) {
            const status = mapCheckpoint(checkpoint.checkpoint_action, summary);
            const happenedAt = eventTime(checkpoint.checkpoint_date_time);
            if (!status || !happenedAt) { result.skipped++; continue; }
            const detailMessage = [checkpoint.checkpoint_action, checkpoint.checkpoint_notes, checkpoint.checkpoint_location]
              .map((v) => String(v || "").trim()).filter(Boolean).join(" · ").slice(0, 255);
            const returnMarker = status === "FAILURE" && (classified.status === "RETURNING" || classified.status === "RETURNED")
              ? ` — ${classified.label.toUpperCase()}` : "";
            const message = `ACS ${number}: ${detailMessage}${returnMarker}`.slice(0, 255);
            const duplicate = existing.some((event) => event.happenedAt === happenedAt && event.message === message);
            if (duplicate) { result.skipped++; continue; }
            const data = await graph(admin, CREATE_EVENT, { event: {
              fulfillmentId: fulfillment.id,
              status,
              happenedAt,
              message,
              city: checkpoint.checkpoint_location || undefined,
              country: "GR",
            } });
            const payload = data.fulfillmentEventCreate;
            if (payload.userErrors?.length) throw new Error(payload.userErrors.map((e) => e.message).join("; "));
            existing.push(payload.fulfillmentEvent);
            result.created++;
          }
          const finalStatus = summaryEventStatus(classified.status);
          const summaryEventAt = eventTime(summary.delivery_date) || snapshot.lastEventAt || new Date().toISOString();
          const summaryTime = new Date(summaryEventAt).getTime();
          const alreadyRepresented = finalStatus && existing.some((event) =>
            event.status === finalStatus &&
            Number.isFinite(new Date(event.happenedAt).getTime()) && new Date(event.happenedAt).getTime() >= summaryTime &&
            (classified.status !== "RETURNED" || /RESTITUITO AL MITTENTE/.test(event.message || ""))
          );
          if (finalStatus && !alreadyRepresented) {
            const stateMessage = classified.status === "DELIVERED"
              ? `ACS confirms delivery to the recipient (shipment_status 4; delivery_flag 1).`
              : classified.status === "RETURNED"
                ? `ACS confirms return to sender: RESTITUITO AL MITTENTE (shipment_status 7; returned_flag 1).`
                : `ACS shipment state: ${classified.label}${snapshot.reasonCode ? ` (${snapshot.reasonCode})` : ""}.`;
            const data = await graph(admin, CREATE_EVENT, { event: {
              fulfillmentId: fulfillment.id,
              status: finalStatus,
              happenedAt: summaryEventAt,
              message: `ACS ${number}: ${stateMessage}`.slice(0, 255),
              country: "GR",
            } });
            const payload = data.fulfillmentEventCreate;
            if (payload.userErrors?.length) throw new Error(payload.userErrors.map((e) => e.message).join("; "));
            existing.push(payload.fulfillmentEvent);
            result.created++;
          }
        } catch (error) {
          try {
            const message = error?.message || "Errore ACS/Shopify";
            const where = { shop_voucherNo: { shop, voucherNo: String(number) } };
            const oldSnapshot = await prisma.acsTrackingSnapshot.findUnique({ where });
            await prisma.acsTrackingSnapshot.upsert({
              where,
              create: {
                shop, orderId: order.id, orderName: order.name, fulfillmentId: fulfillment.id,
                voucherNo: String(number), recipientName: order.shippingAddress?.name || null,
                status: "SYNC_ERROR", statusLabel: "Errore di aggiornamento", error: message,
              },
              update: {
                ...(oldSnapshot ? {} : { status: "SYNC_ERROR", statusLabel: "Errore di aggiornamento" }),
                error: message,
                lastCheckedAt: new Date(),
              },
            });
          } catch (dbError) {
            console.error("ACS TRACKING SNAPSHOT ERROR:", dbError);
          }
          result.errors.push({ order: order.name, voucher: number, message: error?.message || "Errore ACS/Shopify" });
        }
      }
    }
    return result;
}
