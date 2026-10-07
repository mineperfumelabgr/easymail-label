# ACS tracking status and dashboard correction

Incremental overlay for the deployed ACS fulfillment-event deduplication patch.

## Changes

- Refreshes the saved Shopify fulfillment status and fulfillment dates for already returned or delivered snapshots, even when the ACS request is skipped. This prevents the Shipment Dashboard from retaining a stale Shopify status forever.
- Stores Shopify order creation time and sorts the Shipment Dashboard by newest order first, falling back to fulfillment creation time for existing rows until refreshed.
- Requests the newest Shopify fulfillment events first, so status checks are based on the latest event history rather than the oldest 100 events.
- For ACS return states, timestamps the Shopify event from the latest ACS checkpoint when available, instead of preferring the summary `delivery_date` field.
- Reloads previously tracked non-delivered orders by Shopify ID even when they are older than the recent-order discovery window. This keeps known open shipments in the 30-minute sync.
- Stops automatic ACS polling after 90 days from fulfillment creation (falling back to order creation). Unresolved shipments move to `ACS_REVIEW_REQUIRED` and appear under “Manual review”; no Shopify fulfillment event or tag is generated for this unverified state.
- Delivered and returned snapshots are excluded from the background refresh of previously tracked open orders. Delivered stays terminal; returned stays terminal when Shopify already has the matching return event.
- Labels Shopify `FAILURE` explicitly as the return event in the dashboard, and gives `LABEL_PRINTED` a readable label.
- Adds the Prisma migration `20261007000200_add_order_created_at_tracking_sort`.

## Apply

1. Overlay the ZIP contents onto the project root.
2. Run `npm run typecheck` and `npm run build`.
3. Commit and push the changed service, dashboard route, Prisma schema, and migration. Do not stage unrelated `README.txt` or `shopify.app.toml` edits.
4. Wait for the Render Web Service deploy to finish.
5. In the Render Web Service Shell, run `npm run setup` to apply the migration.
6. No `shopify app deploy` is needed; this patch changes no Shopify scopes or app configuration.

## Current sync limit

New shipment discovery reads at most 250 newest Shopify orders per run (5 pages of 50). Previously tracked open shipments are refreshed by Shopify ID while they are younger than 90 days, in batches of five order IDs. At 90 days, unresolved shipments are marked for manual review and removed from automatic ACS polling. Previously tracked delivered and returned shipments are not refreshed. An older order never discovered and without a tracking snapshot can still be outside the 250-order discovery window. The checked count is vouchers, not orders.
