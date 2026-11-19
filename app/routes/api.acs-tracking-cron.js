import { syncGenikiFulfillment } from "../services/geniki-operations.server";
import { syncGenikiTracking } from "../services/geniki.server";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runAcsTrackingSync } from "../services/acs-tracking-sync.server";
import {compactOldTracking} from "../services/tracking-retention.server";

export async function action({ request }) {
  const expected = process.env.ACS_TRACKING_CRON_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !supplied || supplied !== expected) {
    return Response.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  try {
    const sessions = await prisma.session.findMany({
      where: { isOnline: false },
      select: { shop: true },
    });
    const allShops = [...new Set(sessions.map((session) => session.shop))];
    const ignoredShops = allShops.filter((shop) => /-dev\.myshopify\.com$/i.test(shop));
    const distinct = allShops.filter((shop) => !/-dev\.myshopify\.com$/i.test(shop));
    const shops = [];
    for (const shop of distinct) {
      try {
        // Uses Shopify's session storage and SDK token refresh for expiring offline tokens.
        const { admin } = await unauthenticated.admin(shop);
        const acs = await runAcsTrackingSync(admin, shop).catch(error=>({error:error.message}));
        const geniki = await syncGenikiTracking(prisma, shop, (row,status)=>syncGenikiFulfillment(admin,row,status)).catch(error => ({error:error.message}));
        const retention=await compactOldTracking(prisma,shop).catch(error=>({error:error.message}));
        shops.push({shop,...acs,geniki,retention});
      } catch (error) {
        shops.push({ shop, error: error?.message || "Sync failed" });
      }
    }
    return Response.json({ success: true, shops, ignoredShops });
  } catch (error) {
    console.error("ACS TRACKING CRON ERROR:", error);
    return Response.json({ success: false, message: error?.message || "Scheduled sync failed" }, { status: 500 });
  }
}
