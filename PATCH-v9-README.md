# ACS usability and custom shipment patch (incremental after v8)

This patch overlays the v8 source. It does not include the older v5 batch-label extension changes because those were already installed.

## Included
- Tracking dashboard: newest fulfillments first, localized English/Greek label-created status, colored state badges/icons, and direct ACS tracking links.
- ACS tracking sync: an active ACS fulfillment with no first ACS summary scan is represented as `LABEL_CREATED` / awaiting pickup rather than a false sync error. Real ACS/Shopify errors remain errors, and previously confirmed shipment states are preserved.
- ACS Daily Labels: shipment selection and a merged PDF for selected labels; pickup-list issue button and pickup-list details are grouped together.
- Home cards for ACS Daily Labels, Tracking, Tag Settings, and Custom ACS Shipment. EasyMail remains in app navigation.
- Custom ACS Shipment: create direct ACS labels for GR/CY/BG, COD, packages, pickup date, recipient details; view/print recent manual labels.
- n8n read endpoint `GET /api/acs-tracking-status`: Bearer auth, one-voucher refresh only, 30-minute freshness cache, shared ACS normalization, safe deterministic customer summary, and no ACS secrets in n8n. It never launches the 250-order sync.
- Prisma model and migration for manual ACS shipments.

## Apply
1. Unzip this patch over the existing v8 project folder, preserving the directory structure.
2. Run `npm install` if needed.
3. Run `npm run typecheck` and `npm run build`.
4. Commit/push and wait for the Render web service deployment.
5. In Render Shell run `npm run setup` to apply the new `AcsManualShipment` migration and regenerate Prisma Client (or use your normal release command if it already runs `npm run setup`).
6. Run `shopify app deploy` from the project folder to release the updated app navigation/configuration to Shopify, then open the app again.

## n8n ACS tracking endpoint setup
Add these private environment variables to the Render **web service** (not the Cron Job):
- `N8N_ACS_READ_SECRET`: generate a long random secret (at least 32 random bytes). Put the exact same secret in n8n credential/config as `courier_tracking_bearer_token`.
- `N8N_ACS_SHOP`: the authorized shop domain, e.g. `7gidg0-ut.myshopify.com` if this is the production store.

Set n8n's `courier_tracking_base_url` to `https://easymail-label.onrender.com`, path to `/api/acs-tracking-status`, freshness to `30`, and enable tracking. Request example:
`GET https://easymail-label.onrender.com/api/acs-tracking-status?voucher=9811954305&freshness_minutes=30`
with header `Authorization: Bearer <same secret>`. Never put the bearer secret in a query parameter or log it. Test a recent cached voucher, an expired voucher, invalid voucher and wrong token before enabling autopilot. The endpoint returns a safe unavailable response on ACS failure so n8n can block automated replies.

No new Render services are required. Existing ACS credentials and `ACS_BILLING_CODE` are used.

## Important scope note
The selected-label action supports printing selected vouchers. Bulk delete is intentionally not included yet: the current delete endpoint clears all ACS metadata on an order and can affect other parcels attached to a partially fulfilled order. It needs a targeted per-voucher metadata update before enabling multi-delete safely.

Custom shipments are saved in their own history and do not create a Shopify order, fulfillment, event, or order tag. Their tracking URL opens ACS directly.
