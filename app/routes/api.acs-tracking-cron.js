import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runAcsTrackingSync } from "../services/acs-tracking-sync.server";

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
    const distinct = [...new Set(sessions.map((session) => session.shop))];
    const shops = [];
    for (const shop of distinct) {
      try {
        // Uses Shopify's session storage and SDK token refresh for expiring offline tokens.
        const { admin } = await unauthenticated.admin(shop);
        shops.push({ shop, ...(await runAcsTrackingSync(admin, shop)) });
      } catch (error) {
        shops.push({ shop, error: error?.message || "Sync failed" });
      }
    }
    return Response.json({ success: true, shops });
  } catch (error) {
    console.error("ACS TRACKING CRON ERROR:", error);
    return Response.json({ success: false, message: error?.message || "Scheduled sync failed" }, { status: 500 });
  }
}
