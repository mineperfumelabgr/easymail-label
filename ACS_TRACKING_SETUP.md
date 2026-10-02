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
