# Order voucher actions

Prepare orders offers **New voucher** for already fulfilled orders. It adds a
tracking number to a selected existing fulfillment, preserves previous vouchers,
and does not create/cancel a Shopify fulfillment or reset its status. ACS and
Geniki can be selected. COD defaults to the current outstanding COD balance, so
a paid order defaults to zero even when tagged COD.

Daily Labels offers **Replace voucher**. The server validates the selected
shipment, asks the carrier to cancel it, and requires confirmation before creating
the replacement. Cancellation refusal stops the operation. Once issued, only the
selected old voucher numbers are removed from Shopify tracking; unrelated numbers
remain. Delivered/returned records require New voucher instead.

Forms require parcels, packed weight, COD (zero for prepaid), pickup date using a
calendar, employee, and explicit confirmation. Geniki receives the order name in
its printable Comments field and the chosen ReceivedDate. PDFs open through the
existing print-preview flow after creation. PDF failure does not hide an issued
voucher or invite reissuance.

Operations use existing CourierShipment records (no schema migration). Each form
has a unique reference and all carrier requests are recorded before submission.
PostgreSQL advisory transaction locks serialize operation registration per order
and tracking updates per fulfillment. Duplicate posts reuse the issued voucher;
an unresolved earlier operation blocks another request. Issued-but-unsynchronized
vouchers expose Retry tracking sync, which never calls Create or Cancel again.
Ambiguous carrier failures remain on file for manual reconciliation.

ACS additional vouchers are persisted immediately after issue and are discovered
by tracking sync even on mixed-carrier fulfillments or older orders. Cancelled
stored vouchers are excluded from polling. Geniki waits for the pending Shopify
tracking update before scheduled tracking sync.

For a newly issued Geniki voucher, tracking result 9 is treated as awaiting
registration only after GetJobsFromOrderId confirms the exact voucher on our own
open, uncancelled job. Unknown, closed, cancelled and mismatched jobs remain
errors. No delivery or Shopify fulfillment event is inferred from this fallback.
Production lookup responses can report Count=0 while containing a concrete job.
Lookup/recovery therefore requires exactly one returned job with a matching
OrderId, job ID and uncancelled flag, plus an exact voucher match when known.

Tracking offers **Create customer return** / **Print customer return** for Geniki
shipments. This opens the existing customer-requested return coupon flow and never
emails the coupon automatically. Geniki must enable its RR permission for the
account. Historical return and original shipment references remain intact.

Order search is sent to Shopify before paging, rather than filtering only the
latest 50–200 fetched orders. The selected fulfillment status still applies, and
Shopify's authorized order-history window remains in effect.

Packing slips are a separate outstanding integration: the existing generated PDF
does not use the merchant's native Shopify template. Do not describe it as the
Shopify template. The native print-page URL/template is needed before changing
that print path; it is not exposed by the public Admin schema used by the app.

Validation: production build, local 2026-10 schema checks, route loader/SSR checks,
and `node --test tests/voucher-operations.test.mjs` with mocked carrier boundaries.
No real voucher was created or cancelled during development or verification.
