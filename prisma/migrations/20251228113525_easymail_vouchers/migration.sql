-- CreateTable
CREATE TABLE "EasymailVoucher" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT,
    "shipmentNumber" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "EasymailVoucher_shop_createdAt_idx" ON "EasymailVoucher"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EasymailVoucher_shop_orderId_key" ON "EasymailVoucher"("shop", "orderId");
