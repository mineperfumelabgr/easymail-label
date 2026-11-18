ALTER TABLE "CourierShipment" ADD COLUMN "sourceOrderId" TEXT, ADD COLUMN "previousId" TEXT;
CREATE UNIQUE INDEX "CourierShipment_previousId_key" ON "CourierShipment"("previousId");
CREATE TABLE "GenikiTagRule" ("shop" TEXT NOT NULL,"status" TEXT NOT NULL,"tag" TEXT NOT NULL,PRIMARY KEY ("shop","status"));
