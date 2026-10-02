import { authenticate } from "../shopify.server";
import { runAcsTrackingSync } from "../services/acs-tracking-sync.server";

export async function action({ request }) {
  try {
    const { admin, session } = await authenticate.admin(request);
    return Response.json({ success: true, ...(await runAcsTrackingSync(admin, session.shop)) });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("ACS TRACKING SYNC ERROR:", error);
    return Response.json({ success: false, message: error?.message || "Sincronizzazione fallita." }, { status: 500 });
  }
}
