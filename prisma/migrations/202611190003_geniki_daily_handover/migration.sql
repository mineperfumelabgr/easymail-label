CREATE TABLE "GenikiDailyHandover" (
  "shop" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "finalizedAt" TIMESTAMP(3) NOT NULL,
  "confirmations" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "GenikiDailyHandover_pkey" PRIMARY KEY ("shop", "date", "environment")
);
