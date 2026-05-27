-- CreateTable
CREATE TABLE "FundingEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "fundingUsd" REAL NOT NULL,
    "execTime" DATETIME NOT NULL,
    "execId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "FundingEvent_execId_key" ON "FundingEvent"("execId");

-- CreateIndex
CREATE INDEX "FundingEvent_symbol_execTime_idx" ON "FundingEvent"("symbol", "execTime");
