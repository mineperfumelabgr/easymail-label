# ACS tracking sync

The app's **ACS Tracking** screen runs a manual sync. The scheduled endpoint is
`POST /api/acs-tracking-cron` and is protected by the `ACS_TRACKING_CRON_SECRET`
environment variable. It uses Shopify's SDK to load and refresh the installed
app's offline session from the existing PostgreSQL session table.

Tracking snapshots are stored in PostgreSQL. The new Prisma migration must run
before opening the tracking page. The supplied Docker start command already runs
`npm run setup` (Prisma generation and migrations); if production starts with
`npm run start` directly, change it to `npm run setup && npm run start`.

To schedule it on Render:

1. Add a long random `ACS_TRACKING_CRON_SECRET` to the web service environment.
2. Create a Render Cron Job using the same repository and runtime, scheduled
   every 30 minutes. Set `APP_BASE_URL` and `ACS_TRACKING_CRON_SECRET` in that
   job's environment.
3. Use this command (replace the base URL through the environment variable):

   ```sh
   curl --fail-with-body --silent --show-error -X POST \
     "$APP_BASE_URL/api/acs-tracking-cron" \
     -H "Authorization: Bearer $ACS_TRACKING_CRON_SECRET"
   ```

4. Review the response and Shopify's fulfillment timeline for test orders
   before relying on unattended updates.

The service already requires `ACS_API_KEY`, `ACS_COMPANY_ID`,
`ACS_COMPANY_PASSWORD`, `ACS_USER_ID`, and `ACS_USER_PASSWORD` for voucher
creation. The tracker reuses those server-side credentials. Do not put them in
the browser, source code, or this Cron Job.

ACS delivery success is only marked delivered when the summary response has
`shipment_status = 4`, `delivery_flag = 1`, and `returned_flag != 1`. A message
or SMS checkpoint alone never marks an order delivered. Return-to-sender uses
ACS `shipment_status` 6/7 and `returned_flag`. Other event mapping uses the
Greek checkpoint text returned by `ACS_TrackingDetails`; verify it against live
responses from the merchant's ACS account before Track123 is removed.

## Shopify Flow tags

Open **ACS Tag Settings** in the app to enable an order tag for each classified
ACS state. Use a different tag for every state, then build a Shopify Flow with
the **Order tags added** trigger and a condition matching that tag. The app adds
the configured tag when the tracking sync observes that state. Tags stay on the
order; the app does not remove earlier state tags. This supports workflows for
delivery, return-to-sender, pickup, and delivery problems without relying on
Shopify fulfillment-event triggers.

The scheduled sync ignores shops whose domain ends in `-dev.myshopify.com`.

The **ACS Tracking** dashboard includes English and Greek, a searchable status
view, separate ACS shipment and Shopify fulfillment status, the fulfillment
creation/delivery timestamps, and a distinct sync-issue indicator. Fulfillments
already confirmed delivered in ACS are skipped on later ACS requests (once the
Shopify delivered event is present); Shopify orders are still read so the page
and newly enabled status-tag rules can be kept current. The manual refresh can
take longer for large batches because ACS is queried for each active voucher.
Tracking numbers are associated with their own Shopify fulfillment. At the
order level, issue/return tags are added when any active ACS parcel has that
status; the delivered tag is added only after all active ACS parcels on the
order are confirmed delivered.
