-- Full-text search: generated tsvector columns + GIN indexes.
-- Weights: A = titles/claims (most important), B = body text, C = metadata.

ALTER TABLE "Source" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("excerpt", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("author", '') || ' ' || coalesce("publisher", '') || ' ' || coalesce("url", '')), 'C')
  ) STORED;
CREATE INDEX "Source_searchVector_idx" ON "Source" USING GIN ("searchVector");

ALTER TABLE "Evidence" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("claim", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("evidenceText", '')), 'B')
  ) STORED;
CREATE INDEX "Evidence_searchVector_idx" ON "Evidence" USING GIN ("searchVector");

ALTER TABLE "ReportSection" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("contentMd", '')), 'B')
  ) STORED;
CREATE INDEX "ReportSection_searchVector_idx" ON "ReportSection" USING GIN ("searchVector");

ALTER TABLE "Claim" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("text", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("statusExplanation", '')), 'B')
  ) STORED;
CREATE INDEX "Claim_searchVector_idx" ON "Claim" USING GIN ("searchVector");

ALTER TABLE "Project" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("prompt", '')), 'B')
  ) STORED;
CREATE INDEX "Project_searchVector_idx" ON "Project" USING GIN ("searchVector");

ALTER TABLE "Note" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("contentMd", '')), 'B')
  ) STORED;
CREATE INDEX "Note_searchVector_idx" ON "Note" USING GIN ("searchVector");

ALTER TABLE "Citation" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("quotedText", '')), 'B')
  ) STORED;
CREATE INDEX "Citation_searchVector_idx" ON "Citation" USING GIN ("searchVector");

-- Supporting index for cross-project search scoping and date filters.
CREATE INDEX "Evidence_projectId_createdAt_idx" ON "Evidence" ("projectId", "createdAt");
