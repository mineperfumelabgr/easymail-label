ALTER TABLE "AcsTrackingSnapshot"
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "trackingDetailsPurgedAt" TIMESTAMP(3);

ALTER TABLE "CourierShipment"
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "trackingDetailsPurgedAt" TIMESTAMP(3);

-- Backfill only a confirmed terminal event. Creation and polling dates are
-- deliberately not used as evidence of delivery for ACS history.
UPDATE "AcsTrackingSnapshot"
SET "completedAt"=CASE WHEN "status"='DELIVERED'
  THEN COALESCE("fulfillmentDeliveredAt","lastEventAt")
  ELSE "lastEventAt" END
WHERE "status" IN ('DELIVERED','RETURNED');

UPDATE "AcsTrackingSnapshot" SET "completedAt"=NULL
WHERE "completedAt" < TIMESTAMP '2000-01-01' OR "completedAt">CURRENT_TIMESTAMP;

-- Geniki previously stored no completion timestamp. Last observation is a
-- conservative starting point; only verified terminal states are included.
UPDATE "CourierShipment"
SET "completedAt"=CASE WHEN "checkedAt" BETWEEN TIMESTAMP '2000-01-01' AND CURRENT_TIMESTAMP
  THEN "checkedAt" ELSE CURRENT_TIMESTAMP END
WHERE "carrier"='Geniki' AND "genikiTerminalSynced"=true
  AND "status" IN ('DELIVERED','RETURN TO SENDER');

CREATE INDEX "acs_tracking_retention_idx"
  ON "AcsTrackingSnapshot"("shop","trackingDetailsPurgedAt","completedAt");
CREATE INDEX "courier_tracking_retention_idx"
  ON "CourierShipment"("shop","trackingDetailsPurgedAt","completedAt");
