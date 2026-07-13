-- Research Analyst Layer: project watchlist metadata + stored report health.
ALTER TABLE "Project" ADD COLUMN "watched" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD COLUMN "watchCadence" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "Project" ADD COLUMN "lastCheckedAt" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN "nextCheckAt" TIMESTAMP(3);
ALTER TABLE "Report" ADD COLUMN "healthJson" JSONB;
