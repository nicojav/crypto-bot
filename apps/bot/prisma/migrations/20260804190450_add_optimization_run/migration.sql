-- CreateTable
CREATE TABLE "OptimizationRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "configJson" TEXT NOT NULL,
    "resultsJson" TEXT NOT NULL DEFAULT '[]',
    "cellsTotal" INTEGER NOT NULL DEFAULT 0,
    "cellsDone" INTEGER NOT NULL DEFAULT 0,
    "backtestsRun" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "OptimizationRun_status_createdAt_idx" ON "OptimizationRun"("status", "createdAt");
