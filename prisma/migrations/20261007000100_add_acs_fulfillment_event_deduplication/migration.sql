ALTER TABLE "AcsTrackingSnapshot"
ADD COLUMN "lastShopifyEventStatus" TEXT,
ADD COLUMN "lastShopifyCheckpointAt" TIMESTAMP(3);
