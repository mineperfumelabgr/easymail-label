CREATE TABLE "AcsManualShipment" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "recipientName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT,
  "company" TEXT,
  "address" TEXT NOT NULL,
  "floor" TEXT,
  "city" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "zip" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  "pieces" INTEGER NOT NULL DEFAULT 1,
  "codAmount" DOUBLE PRECISION,
  "pickupDate" TEXT NOT NULL,
  "reference" TEXT,
  "voucherNo" TEXT NOT NULL,
  "shipmentNumbers" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AcsManualShipment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AcsManualShipment_shop_voucherNo_key" ON "AcsManualShipment"("shop", "voucherNo");
CREATE INDEX "AcsManualShipment_shop_createdAt_idx" ON "AcsManualShipment"("shop", "createdAt");
