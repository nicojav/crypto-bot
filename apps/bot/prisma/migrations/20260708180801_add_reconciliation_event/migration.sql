-- CreateTable
CREATE TABLE "ReconciliationEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "tradeId" INTEGER,
    "symbol" TEXT,
    "message" TEXT NOT NULL,
    "detailsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ReconciliationEvent_type_createdAt_idx" ON "ReconciliationEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "ReconciliationEvent_symbol_createdAt_idx" ON "ReconciliationEvent"("symbol", "createdAt");
