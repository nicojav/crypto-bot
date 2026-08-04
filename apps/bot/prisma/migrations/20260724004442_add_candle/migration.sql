-- CreateTable
CREATE TABLE "Candle" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openTime" INTEGER NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "volume" REAL NOT NULL
);

-- CreateIndex
CREATE INDEX "Candle_symbol_timeframe_openTime_idx" ON "Candle"("symbol", "timeframe", "openTime");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_symbol_timeframe_openTime_key" ON "Candle"("symbol", "timeframe", "openTime");
