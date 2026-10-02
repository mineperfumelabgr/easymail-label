CREATE TABLE "AcsTrackingTagRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "tag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AcsTrackingTagRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AcsTrackingTagRule_shop_status_key"
    ON "AcsTrackingTagRule"("shop", "status");
CREATE INDEX "AcsTrackingTagRule_shop_idx"
    ON "AcsTrackingTagRule"("shop");
