ALTER TABLE "AcsTrackingSnapshot"
  ADD COLUMN "fulfillmentStatus" TEXT,
  ADD COLUMN "fulfillmentCreatedAt" TIMESTAMP(3),
  ADD COLUMN "fulfillmentDeliveredAt" TIMESTAMP(3);
