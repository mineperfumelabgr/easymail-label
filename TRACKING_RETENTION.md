# Tracking detail retention

The authenticated Render tracking job runs compaction after its normal ACS and
Geniki sync. The policy is 12 calendar months after confirmed delivery or return,
not after order creation, label creation, or the most recent poll.

At most 200 ACS snapshots and 200 Geniki shipments are processed per run. The
existing 30-minute cron schedule is reused. Indexed eligibility checks and a
`trackingDetailsPurgedAt` marker keep subsequent runs small and idempotent.

Eligible ACS snapshots must be delivered or returned, have a completion date,
have no stored sync error, and have sent the corresponding terminal Shopify
event. Eligible Geniki records must be live, terminal, and fully synchronized
(or a confirmed terminal manual shipment with no Shopify fulfillment to sync).
Active/problem shipments, unknown completion dates, unsynchronized records,
pending return requests, and issued return coupons are preserved. Return coupons
are conservatively protected because their closed/expired status is not stored.

Compaction clears recipient/customer names, email, phone, address previews,
checkpoint/reason/location details, error text, and the completed fulfillment
plan. It retains the shipment row and the voucher/parcel numbers, job/reference,
Shopify order/customer/fulfillment IDs, terminal state/date, country, parcel/COD
and preparation data, and return/replacement references. Reprinting and existing
voucher detection continue using those retained identifiers. No Shopify order,
fulfillment, carrier voucher, or return request is cancelled or deleted.

The loader and ACS sync do not repopulate compacted contact details. Their writes
also check the marker, protecting against refreshes that started before a sweep.
Eligibility is rechecked on write, including pending-return and sync guards.

Historical ACS completion dates use delivery/terminal checkpoint timestamps.
When Geniki has no trustworthy timestamp, the first confirmed observation starts
the clock. Creation dates are never substituted. Unknown or invalid dates are
retained longer rather than compacted early.

Removed details are not available from the app's database afterwards. PDFs are
requested from the carrier using retained voucher numbers, subject to the
carrier's availability. PostgreSQL can reuse the freed space; compaction does
not reduce Render's allocated storage capacity or guarantee a smaller volume.

Checks: `node --test tests/courier-workspace.test.mjs tests/tracking-retention.test.mjs`
