-- Storytelling workflow: stories, versioned artifacts, skill-invocation
-- records, and locked facts (hand-written; the searchVector generated
-- columns from 0002 are intentionally untouched).

CREATE TABLE "Story" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'auto',
    "resolvedMode" TEXT,
    "framework" TEXT,
    "frameworkReason" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'youtube-long',
    "targetDurationSec" INTEGER NOT NULL DEFAULT 480,
    "settingsJson" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "providerUsed" TEXT,
    "skillId" TEXT,
    "skillHash" TEXT,
    "packageVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Story_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoryVersion" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "contentJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoryInvocation" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "skillId" TEXT,
    "skillHash" TEXT,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "packageVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryInvocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StoryLockedFact" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "evidenceRef" TEXT NOT NULL,
    "evidenceId" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StoryLockedFact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Story_projectId_updatedAt_idx" ON "Story"("projectId", "updatedAt");
CREATE UNIQUE INDEX "StoryVersion_storyId_kind_version_key" ON "StoryVersion"("storyId", "kind", "version");
CREATE INDEX "StoryVersion_storyId_kind_version_idx" ON "StoryVersion"("storyId", "kind", "version");
CREATE INDEX "StoryInvocation_storyId_createdAt_idx" ON "StoryInvocation"("storyId", "createdAt");
CREATE UNIQUE INDEX "StoryLockedFact_storyId_evidenceRef_key" ON "StoryLockedFact"("storyId", "evidenceRef");

ALTER TABLE "Story" ADD CONSTRAINT "Story_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryVersion" ADD CONSTRAINT "StoryVersion_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryInvocation" ADD CONSTRAINT "StoryInvocation_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryLockedFact" ADD CONSTRAINT "StoryLockedFact_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
