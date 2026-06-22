-- Migration: add TP/SL storage and confirmation flag to Trade table.
-- All columns are nullable/defaulted so existing rows are unaffected.

ALTER TABLE "Trade" ADD COLUMN "takeProfitPrice" REAL;
ALTER TABLE "Trade" ADD COLUMN "stopLossPrice" REAL;
ALTER TABLE "Trade" ADD COLUMN "tpslSet" BOOLEAN NOT NULL DEFAULT false;
