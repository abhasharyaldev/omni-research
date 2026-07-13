import { formatCitation } from "@omni/crawler";
import type { PrismaClient } from "@omni/database";
import type { CitationStyle } from "@omni/shared";

export type ExportFormat =
  | "markdown"
  | "html"
  | "json"
  | "csv-sources"
  | "csv-flashcards"
  | "bibliography";

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build an export for the latest report of a project. Returns text content. */
export async function buildExport(
  prisma: PrismaClient,
  projectId: string,
  format: ExportFormat,
  citationStyleOverride?: CitationStyle
): Promise<{ content: string; mimeType: string; filename: string }> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const report = await prisma.report.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: {
      sections: { orderBy: { order: "asc" } },
      citations: { orderBy: { marker: "asc" }, include: { source: true } },
      run: true,
    },
  });
  const sources = await prisma.source.findMany({
    where: { projectId, duplicateOfId: null },
    orderBy: { qualityScore: "desc" },
  });
  const style = (citationStyleOverride ?? project.citationStyle) as CitationStyle;
  const generatedAt = new Date();

  const bibliographyLines = (report?.citations ?? []).map((citation) => {
    const s = citation.source;
    return formatCitation(
      {
        title: s.title ?? undefined,
        author: s.author ?? undefined,
        publisher: s.publisher ?? undefined,
        publishedAt: s.publishedAt ?? undefined,
        retrievedAt: s.retrievedAt ?? citation.createdAt,
        url: s.finalUrl ?? s.url,
        pageNumber: citation.pageNumber ?? undefined,
      },
      style
    );
  });

  switch (format) {
    case "markdown": {
      const parts: string[] = [
        `# ${report?.title ?? project.title}`,
        `> Generated ${generatedAt.toISOString()} · Mode: ${project.mode} · Provider: ${report?.providerUsed ?? "n/a"} · Citation style: ${style}`,
        `**Research question / request:** ${project.prompt}`,
      ];
      for (const section of report?.sections ?? []) {
        parts.push(`## ${section.title}\n\n${section.contentMd}`);
      }
      if (report?.citations.length) {
        parts.push(
          `## Sources\n\n${report.citations
            .map((c, i) => `${c.marker}. ${bibliographyLines[i]}${c.verified ? "" : " *(unverified)*"}`)
            .join("\n")}`
        );
      }
      if (report?.methodology) parts.push(`## Research methodology\n\n${report.methodology}`);
      return {
        content: parts.join("\n\n"),
        mimeType: "text/markdown",
        filename: `${project.id}-report.md`,
      };
    }
    case "html": {
      const md = await buildExport(prisma, projectId, "markdown", citationStyleOverride);
      const body = escapeHtml(md.content)
        .split("\n")
        .map((line) => {
          if (line.startsWith("# ")) return `<h1>${line.slice(2)}</h1>`;
          if (line.startsWith("## ")) return `<h2>${line.slice(3)}</h2>`;
          if (line.startsWith("- ")) return `<li>${line.slice(2)}</li>`;
          if (line.startsWith("&gt; ")) return `<blockquote>${line.slice(5)}</blockquote>`;
          return line ? `<p>${line}</p>` : "";
        })
        .join("\n");
      return {
        content: `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(project.title)}</title><style>body{font-family:Georgia,serif;max-width:820px;margin:2rem auto;padding:0 1rem;line-height:1.6}</style></head><body>${body}</body></html>`,
        mimeType: "text/html",
        filename: `${project.id}-report.html`,
      };
    }
    case "json": {
      return {
        content: JSON.stringify(
          {
            project: {
              id: project.id,
              title: project.title,
              mode: project.mode,
              prompt: project.prompt,
              citationStyle: style,
            },
            generatedAt: generatedAt.toISOString(),
            providerUsed: report?.providerUsed ?? null,
            report: report
              ? {
                  title: report.title,
                  methodology: report.methodology,
                  limitations: report.limitations,
                  verifiedAt: report.verifiedAt,
                  sections: report.sections.map((s) => ({ kind: s.kind, title: s.title, contentMd: s.contentMd })),
                  citations: report.citations.map((c) => ({
                    marker: c.marker,
                    verified: c.verified,
                    quotedText: c.quotedText,
                    locator: c.locator,
                    pageNumber: c.pageNumber,
                    source: {
                      title: c.source.title,
                      author: c.source.author,
                      publisher: c.source.publisher,
                      url: c.source.finalUrl ?? c.source.url,
                      publishedAt: c.source.publishedAt,
                      retrievedAt: c.source.retrievedAt,
                    },
                  })),
                }
              : null,
            sources: sources.map((s) => ({
              title: s.title,
              url: s.finalUrl ?? s.url,
              author: s.author,
              publisher: s.publisher,
              publishedAt: s.publishedAt,
              retrievedAt: s.retrievedAt,
              classification: s.classification,
              qualityScore: s.qualityScore,
            })),
          },
          null,
          2
        ),
        mimeType: "application/json",
        filename: `${project.id}-archive.json`,
      };
    }
    case "csv-sources": {
      const header = "title,url,author,publisher,published_at,retrieved_at,classification,quality_score,word_count";
      const rows = sources.map((s) =>
        [
          csvEscape(s.title),
          csvEscape(s.finalUrl ?? s.url),
          csvEscape(s.author ?? "Author unavailable"),
          csvEscape(s.publisher ?? ""),
          csvEscape(s.publishedAt?.toISOString() ?? "Publication date unavailable"),
          csvEscape(s.retrievedAt?.toISOString() ?? ""),
          csvEscape(s.classification),
          csvEscape(s.qualityScore),
          csvEscape(s.wordCount),
        ].join(",")
      );
      return {
        content: [header, ...rows].join("\n"),
        mimeType: "text/csv",
        filename: `${project.id}-sources.csv`,
      };
    }
    case "csv-flashcards": {
      const quizzes = await prisma.quizQuestion.findMany({
        where: { quiz: { lesson: { unit: { plan: { projectId } } } } },
        orderBy: { order: "asc" },
      });
      const header = "front,back";
      const rows = quizzes.map((q) => `${csvEscape(q.prompt)},${csvEscape(q.correctAnswer)}`);
      return {
        content: [header, ...rows].join("\n"),
        mimeType: "text/csv",
        filename: `${project.id}-flashcards.csv`,
      };
    }
    case "bibliography": {
      const lines =
        bibliographyLines.length > 0
          ? bibliographyLines
          : sources.map((s) =>
              formatCitation(
                {
                  title: s.title ?? undefined,
                  author: s.author ?? undefined,
                  publisher: s.publisher ?? undefined,
                  publishedAt: s.publishedAt ?? undefined,
                  retrievedAt: s.retrievedAt ?? new Date(),
                  url: s.finalUrl ?? s.url,
                },
                style
              )
            );
      return {
        content: lines.join("\n\n"),
        mimeType: "text/plain",
        filename: `${project.id}-bibliography-${style}.txt`,
      };
    }
  }
}
