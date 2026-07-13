import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@omni/database";
import { SEARCH_HIT_TYPES, searchQuerySchema, type SearchHit, type SearchHitType } from "@omni/shared";
import { requireUser } from "../auth.js";

/**
 * Cross-project full-text search over PostgreSQL generated tsvector columns
 * (migration 0002). Every query is scoped to the authenticated owner and uses
 * parameterized SQL only. Snippets come from ts_headline with [[ ]] delimiters
 * — plain text the client converts to <mark>, so no HTML ever round-trips.
 */

const HEADLINE_OPTS = `StartSel=[[, StopSel=]], MaxWords=22, MinWords=8, MaxFragments=2, FragmentDelimiter=" … "`;

type RawHit = {
  entityId: string;
  projectId: string;
  projectTitle: string;
  title: string | null;
  snippet: string | null;
  rank: number;
  date: Date | null;
  extraA?: string | null;
  extraB?: string | null;
  extraC?: number | null;
};

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.get("/api/search", async (request) => {
    const user = requireUser(request);
    const input = searchQuerySchema.parse(request.query);

    const requestedTypes: SearchHitType[] = input.types
      ? (input.types
          .split(",")
          .map((t) => t.trim())
          .filter((t): t is SearchHitType => (SEARCH_HIT_TYPES as string[]).includes(t)) as SearchHitType[])
      : [...SEARCH_HIT_TYPES];

    const perTypeLimit = Math.min(input.limit, 40);
    const scope = {
      ownerId: user.id,
      projectId: input.projectId ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
    };

    // Shared WHERE fragments (all parameterized via Prisma.sql).
    const projectScope = (projectIdColumn: Prisma.Sql) => Prisma.sql`
      p."ownerId" = ${scope.ownerId}
      AND (${scope.projectId}::text IS NULL OR ${projectIdColumn} = ${scope.projectId})
    `;
    const dateScope = (dateColumn: Prisma.Sql) => Prisma.sql`
      (${scope.from}::timestamp IS NULL OR ${dateColumn} >= ${scope.from})
      AND (${scope.to}::timestamp IS NULL OR ${dateColumn} <= ${scope.to})
    `;
    const query = input.q;

    const hits: SearchHit[] = [];
    const push = (type: SearchHitType, rows: RawHit[], build: (row: RawHit) => Partial<SearchHit>) => {
      for (const row of rows) {
        hits.push({
          type,
          entityId: row.entityId,
          projectId: row.projectId,
          projectTitle: row.projectTitle,
          title: row.title ?? "(untitled)",
          snippet: row.snippet ?? "",
          rank: Number(row.rank) || 0,
          date: row.date ? row.date.toISOString() : null,
          extra: {},
          ...build(row),
        });
      }
    };

    if (requestedTypes.includes("report")) {
      const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
        SELECT rs."id" AS "entityId", p."id" AS "projectId", p."title" AS "projectTitle",
               rs."title" AS "title", rs."reportId" AS "extraA", rs."kind" AS "extraB",
               ts_headline('english', rs."contentMd", websearch_to_tsquery('english', ${query}), ${HEADLINE_OPTS}) AS "snippet",
               ts_rank(rs."searchVector", websearch_to_tsquery('english', ${query})) AS "rank",
               rs."createdAt" AS "date"
        FROM "ReportSection" rs
        JOIN "Report" r ON r."id" = rs."reportId"
        JOIN "Project" p ON p."id" = r."projectId"
        WHERE rs."searchVector" @@ websearch_to_tsquery('english', ${query})
          AND ${projectScope(Prisma.sql`p."id"`)} AND ${dateScope(Prisma.sql`rs."createdAt"`)}
        ORDER BY "rank" DESC LIMIT ${perTypeLimit}
      `);
      push("report", rows, (row) => ({ extra: { reportId: row.extraA ?? undefined, sectionKind: row.extraB ?? undefined } }));
    }

    if (requestedTypes.includes("evidence")) {
      const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
        SELECT e."id" AS "entityId", p."id" AS "projectId", p."title" AS "projectTitle",
               e."claim" AS "title", e."sourceId" AS "extraA", s."qualityScore" AS "extraC",
               ts_headline('english', e."claim" || ' — ' || e."evidenceText", websearch_to_tsquery('english', ${query}), ${HEADLINE_OPTS}) AS "snippet",
               ts_rank(e."searchVector", websearch_to_tsquery('english', ${query})) AS "rank",
               e."createdAt" AS "date"
        FROM "Evidence" e
        JOIN "Project" p ON p."id" = e."projectId"
        JOIN "Source" s ON s."id" = e."sourceId"
        WHERE e."searchVector" @@ websearch_to_tsquery('english', ${query})
          AND ${projectScope(Prisma.sql`p."id"`)} AND ${dateScope(Prisma.sql`e."createdAt"`)}
          AND (${input.minQuality ?? null}::int IS NULL OR s."qualityScore" >= ${input.minQuality ?? 0})
        ORDER BY "rank" DESC LIMIT ${perTypeLimit}
      `);
      push("evidence", rows, (row) => ({
        extra: { sourceId: row.extraA ?? undefined, qualityScore: row.extraC ?? undefined },
      }));
    }

    if (requestedTypes.includes("source")) {
      const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
        SELECT s."id" AS "entityId", p."id" AS "projectId", p."title" AS "projectTitle",
               s."title" AS "title", s."url" AS "extraA", s."classification" AS "extraB", s."qualityScore" AS "extraC",
               ts_headline('english', coalesce(s."title",'') || ' — ' || coalesce(s."excerpt",''), websearch_to_tsquery('english', ${query}), ${HEADLINE_OPTS}) AS "snippet",
               ts_rank(s."searchVector", websearch_to_tsquery('english', ${query})) AS "rank",
               coalesce(s."publishedAt", s."retrievedAt") AS "date"
        FROM "Source" s
        JOIN "Project" p ON p."id" = s."projectId"
        WHERE s."searchVector" @@ websearch_to_tsquery('english', ${query})
          AND ${projectScope(Prisma.sql`p."id"`)} AND ${dateScope(Prisma.sql`coalesce(s."publishedAt", s."retrievedAt", s."createdAt")`)}
          AND (${input.minQuality ?? null}::int IS NULL OR s."qualityScore" >= ${input.minQuality ?? 0})
        ORDER BY "rank" DESC LIMIT ${perTypeLimit}
      `);
      push("source", rows, (row) => ({
        extra: {
          sourceId: row.entityId,
          sourceUrl: row.extraA ?? undefined,
          classification: row.extraB ?? undefined,
          qualityScore: row.extraC ?? undefined,
        },
      }));
    }

    if (requestedTypes.includes("claim")) {
      const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
        SELECT c."id" AS "entityId", p."id" AS "projectId", p."title" AS "projectTitle",
               c."text" AS "title", c."verificationStatus" AS "extraA",
               ts_headline('english', c."text" || ' ' || coalesce(c."statusExplanation",''), websearch_to_tsquery('english', ${query}), ${HEADLINE_OPTS}) AS "snippet",
               ts_rank(c."searchVector", websearch_to_tsquery('english', ${query})) AS "rank",
               c."createdAt" AS "date"
        FROM "Claim" c
        JOIN "Project" p ON p."id" = c."projectId"
        WHERE c."searchVector" @@ websearch_to_tsquery('english', ${query})
          AND ${projectScope(Prisma.sql`p."id"`)} AND ${dateScope(Prisma.sql`c."createdAt"`)}
        ORDER BY "rank" DESC LIMIT ${perTypeLimit}
      `);
      push("claim", rows, (row) => ({ extra: { verificationStatus: row.extraA ?? null } }));
    }

    if (requestedTypes.includes("citation")) {
      const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
        SELECT c."id" AS "entityId", p."id" AS "projectId", p."title" AS "projectTitle",
               s."title" AS "title", c."reportId" AS "extraA", s."id" AS "extraB", c."marker" AS "extraC",
               ts_headline('english', coalesce(c."quotedText",''), websearch_to_tsquery('english', ${query}), ${HEADLINE_OPTS}) AS "snippet",
               ts_rank(c."searchVector", websearch_to_tsquery('english', ${query})) AS "rank",
               c."createdAt" AS "date"
        FROM "Citation" c
        JOIN "Report" r ON r."id" = c."reportId"
        JOIN "Project" p ON p."id" = r."projectId"
        JOIN "Source" s ON s."id" = c."sourceId"
        WHERE c."searchVector" @@ websearch_to_tsquery('english', ${query})
          AND ${projectScope(Prisma.sql`p."id"`)} AND ${dateScope(Prisma.sql`c."createdAt"`)}
        ORDER BY "rank" DESC LIMIT ${perTypeLimit}
      `);
      push("citation", rows, (row) => ({
        extra: { reportId: row.extraA ?? undefined, sourceId: row.extraB ?? undefined, marker: row.extraC ?? undefined },
      }));
    }

    if (requestedTypes.includes("project")) {
      const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
        SELECT p."id" AS "entityId", p."id" AS "projectId", p."title" AS "projectTitle",
               p."title" AS "title", p."mode" AS "extraA",
               ts_headline('english', p."title" || ' — ' || p."prompt", websearch_to_tsquery('english', ${query}), ${HEADLINE_OPTS}) AS "snippet",
               ts_rank(p."searchVector", websearch_to_tsquery('english', ${query})) AS "rank",
               p."updatedAt" AS "date"
        FROM "Project" p
        WHERE p."searchVector" @@ websearch_to_tsquery('english', ${query})
          AND ${projectScope(Prisma.sql`p."id"`)} AND ${dateScope(Prisma.sql`p."updatedAt"`)}
        ORDER BY "rank" DESC LIMIT ${perTypeLimit}
      `);
      push("project", rows, (row) => ({ extra: { sectionKind: row.extraA ?? undefined } }));
    }

    if (requestedTypes.includes("note")) {
      const rows = await prisma.$queryRaw<RawHit[]>(Prisma.sql`
        SELECT n."id" AS "entityId", p."id" AS "projectId", p."title" AS "projectTitle",
               coalesce(n."title", 'Note') AS "title", n."sourceId" AS "extraA",
               ts_headline('english', coalesce(n."title",'') || ' ' || n."contentMd", websearch_to_tsquery('english', ${query}), ${HEADLINE_OPTS}) AS "snippet",
               ts_rank(n."searchVector", websearch_to_tsquery('english', ${query})) AS "rank",
               n."updatedAt" AS "date"
        FROM "Note" n
        JOIN "Project" p ON p."id" = n."projectId"
        WHERE n."searchVector" @@ websearch_to_tsquery('english', ${query})
          AND ${projectScope(Prisma.sql`p."id"`)} AND ${dateScope(Prisma.sql`n."updatedAt"`)}
        ORDER BY "rank" DESC LIMIT ${perTypeLimit}
      `);
      push("note", rows, (row) => ({ extra: { sourceId: row.extraA ?? undefined } }));
    }

    hits.sort((a, b) => b.rank - a.rank);
    return {
      query: input.q,
      total: hits.length,
      hits: hits.slice(0, input.limit),
    };
  });
}
