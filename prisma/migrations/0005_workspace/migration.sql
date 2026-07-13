-- Research workspace: notebook upgrades, timeline events, universal import.

ALTER TABLE "Note" ADD COLUMN "evidenceId" TEXT;
ALTER TABLE "Note" ADD COLUMN "claimId" TEXT;
ALTER TABLE "Note" ADD COLUMN "reportId" TEXT;
ALTER TABLE "Note" ADD COLUMN "storySceneRef" TEXT;
ALTER TABLE "Note" ADD COLUMN "tags" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Note" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Note" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Note" ADD COLUMN "quotedText" TEXT;
ALTER TABLE "Note" ADD COLUMN "sourceLocation" TEXT;
CREATE INDEX "Note_projectId_archived_pinned_updatedAt_idx" ON "Note"("projectId", "archived", "pinned", "updatedAt");
ALTER TABLE "Note" ADD CONSTRAINT "Note_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Note" ADD CONSTRAINT "Note_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "Claim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Note" ADD CONSTRAINT "Note_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TimelineEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'user',
    "entityType" TEXT,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "metaJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TimelineEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TimelineEvent_projectId_createdAt_idx" ON "TimelineEvent"("projectId", "createdAt");
CREATE INDEX "TimelineEvent_projectId_type_createdAt_idx" ON "TimelineEvent"("projectId", "type", "createdAt");
ALTER TABLE "TimelineEvent" ADD CONSTRAINT "TimelineEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview-ready',
    "filename" TEXT,
    "mimeType" TEXT,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "previewJson" JSONB,
    "optionsJson" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ImportJob_projectId_createdAt_idx" ON "ImportJob"("projectId", "createdAt");
CREATE UNIQUE INDEX "ImportJob_projectId_checksum_kind_key" ON "ImportJob"("projectId", "checksum", "kind");
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ImportItem" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT,
    "detail" TEXT,
    "sourceId" TEXT,
    "noteId" TEXT,
    "provenanceJson" JSONB,
    CONSTRAINT "ImportItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ImportItem_jobId_index_idx" ON "ImportItem"("jobId", "index");
ALTER TABLE "ImportItem" ADD CONSTRAINT "ImportItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
