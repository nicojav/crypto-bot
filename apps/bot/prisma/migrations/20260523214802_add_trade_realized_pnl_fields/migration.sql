-- AlterTable
ALTER TABLE "Trade" ADD COLUMN "closingOrderId" TEXT;
ALTER TABLE "Trade" ADD COLUMN "entryFillPrice" REAL;
ALTER TABLE "Trade" ADD COLUMN "exitFillPrice" REAL;
ALTER TABLE "Trade" ADD COLUMN "feeCloseUsd" REAL;
ALTER TABLE "Trade" ADD COLUMN "feeOpenUsd" REAL;
ALTER TABLE "Trade" ADD COLUMN "fundingUsd" REAL;
ALTER TABLE "Trade" ADD COLUMN "pnlSource" TEXT;
ALTER TABLE "Trade" ADD COLUMN "realizedPnlUsd" REAL;

-- CreateIndex
CREATE INDEX "Trade_symbol_status_idx" ON "Trade"("symbol", "status");

-- CreateIndex
CREATE INDEX "Trade_closingOrderId_idx" ON "Trade"("closingOrderId");
