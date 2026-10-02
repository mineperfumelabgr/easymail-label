CREATE TABLE "AcsTrackingSnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "voucherNo" TEXT NOT NULL,
    "recipientName" TEXT,
    "status" TEXT NOT NULL,
    "statusLabel" TEXT NOT NULL,
    "shipmentStatus" INTEGER,
    "deliveryFlag" INTEGER,
    "returnedFlag" INTEGER,
    "reasonCode" TEXT,
    "lastCheckpoint" TEXT,
    "lastLocation" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    CONSTRAINT "AcsTrackingSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AcsTrackingSnapshot_shop_voucherNo_key"
    ON "AcsTrackingSnapshot"("shop", "voucherNo");
CREATE INDEX "AcsTrackingSnapshot_shop_status_lastCheckedAt_idx"
    ON "AcsTrackingSnapshot"("shop", "status", "lastCheckedAt");
CREATE INDEX "AcsTrackingSnapshot_shop_orderName_idx"
    ON "AcsTrackingSnapshot"("shop", "orderName");
CREATE INDEX "AcsTrackingSnapshot_shop_recipientName_idx"
    ON "AcsTrackingSnapshot"("shop", "recipientName");
