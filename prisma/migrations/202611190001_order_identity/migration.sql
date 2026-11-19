ALTER TABLE "CourierShipment"
  ADD COLUMN "customerId" TEXT,
  ADD COLUMN "customerName" TEXT,
  ADD COLUMN "customerEmail" TEXT,
  ADD COLUMN "orderSourceName" TEXT,
  ADD COLUMN "recipientPhone" TEXT;

ALTER TABLE "AcsTrackingSnapshot"
  ADD COLUMN "customerId" TEXT,
  ADD COLUMN "customerName" TEXT,
  ADD COLUMN "customerEmail" TEXT,
  ADD COLUMN "orderSourceName" TEXT,
  ADD COLUMN "recipientPhone" TEXT,
  ADD COLUMN "addressPreview" TEXT,
  ADD COLUMN "country" TEXT;
