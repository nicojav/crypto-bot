-- CreateTable
CREATE TABLE "FundingRate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "fundingTime" INTEGER NOT NULL,
    "fundingRate" REAL NOT NULL
);

-- CreateIndex
CREATE INDEX "FundingRate_symbol_fundingTime_idx" ON "FundingRate"("symbol", "fundingTime");

-- CreateIndex
CREATE UNIQUE INDEX "FundingRate_symbol_fundingTime_key" ON "FundingRate"("symbol", "fundingTime");
