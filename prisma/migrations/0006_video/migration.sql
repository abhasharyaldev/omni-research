-- Video engine: neutral, provider-agnostic extraction artifacts.
CREATE TABLE "VideoAsset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "title" TEXT,
    "durationSec" DOUBLE PRECISION,
    "captionSource" TEXT NOT NULL DEFAULT 'unknown',
    "language" TEXT,
    "detailMode" TEXT NOT NULL DEFAULT 'transcript',
    "frameCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "engineName" TEXT NOT NULL DEFAULT 'claude-video/watch',
    "engineVersion" TEXT,
    "enginePin" TEXT,
    "dataLeftDevice" BOOLEAN NOT NULL DEFAULT false,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "checksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VideoAsset_projectId_createdAt_idx" ON "VideoAsset"("projectId", "createdAt");
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "speaker" TEXT,
    "text" TEXT NOT NULL,
    "checksum" TEXT,
    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TranscriptSegment_videoAssetId_index_key" ON "TranscriptSegment"("videoAssetId", "index");
CREATE INDEX "TranscriptSegment_videoAssetId_index_idx" ON "TranscriptSegment"("videoAssetId", "index");
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
