-- CreateTable
CREATE TABLE "CourierRule" (
    "shop" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,

    CONSTRAINT "CourierRule_pkey" PRIMARY KEY ("shop","country")
);

-- CreateTable
CREATE TABLE "CourierShipment" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "carrier" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "jobId" TEXT,
    "voucher" TEXT,
    "labels" JSONB,
    "checkedAt" TIMESTAMP(3),
    "fulfillmentPlan" JSONB,
    "status" TEXT NOT NULL DEFAULT 'Creating',
    "fulfillmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierShipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourierShipment_reference_key" ON "CourierShipment"("reference");

-- CreateIndex
CREATE INDEX "CourierShipment_shop_carrier_createdAt_idx" ON "CourierShipment"("shop", "carrier", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CourierShipment_shop_orderId_environment_key" ON "CourierShipment"("shop", "orderId", "environment");

