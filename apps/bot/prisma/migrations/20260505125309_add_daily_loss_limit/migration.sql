-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Bot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "maxLeverage" INTEGER NOT NULL DEFAULT 10,
    "maxPositionUsd" REAL NOT NULL DEFAULT 100,
    "dailyLossLimitUsd" REAL NOT NULL DEFAULT -500,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Bot" ("createdAt", "dryRun", "enabled", "id", "maxLeverage", "maxPositionUsd", "name", "symbol") SELECT "createdAt", "dryRun", "enabled", "id", "maxLeverage", "maxPositionUsd", "name", "symbol" FROM "Bot";
DROP TABLE "Bot";
ALTER TABLE "new_Bot" RENAME TO "Bot";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
