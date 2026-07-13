import { formatCitation } from "@omni/crawler";
import type { PrismaClient } from "@omni/database";
import type { CitationStyle } from "@omni/shared";

/**
 * Real DOCX and PDF exports (no renamed HTML). DOCX via the `docx` package
 * (pure JS, produces a genuine OOXML zip); PDF via `pdfkit` (pure JS, built-in
 * Helvetica AFM fonts — no system dependency). Untrusted text is emitted as
 * literal runs only, never as markup.
 */

export type BinaryExportFormat = "docx" | "pdf";

type ExportData = {
  projectTitle: string;
  reportTitle: string;
  generatedAt: Date;
  author: string;
  sections: { title: string; kind: string; contentMd: string }[];
  methodology?: string;
  bibliography: string[];
  verified: boolean;
};

async function collectExportData(prisma: PrismaClient, projectId: string, styleOverride?: CitationStyle): Promise<ExportData> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { owner: true } });
  const report = await prisma.report.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: {
      sections: { orderBy: { order: "asc" } },
      citations: { orderBy: { marker: "asc" }, include: { source: true } },
    },
  });
  if (!report) throw new Error("No report exists for this project yet — run research first.");
  const style = (styleOverride ?? project.citationStyle) as CitationStyle;
  return {
    projectTitle: project.title,
    reportTitle: report.title,
    generatedAt: new Date(),
    author: project.owner.displayName,
    sections: report.sections.map((s) => ({ title: s.title, kind: s.kind, contentMd: s.contentMd })),
    methodology: report.methodology ?? undefined,
    bibliography: report.citations.map((citation) =>
      `[${citation.marker}] ` +
      formatCitation(
        {
          title: citation.source.title ?? undefined,
          author: citation.source.author ?? undefined,
          publisher: citation.source.publisher ?? undefined,
          publishedAt: citation.source.publishedAt ?? undefined,
          retrievedAt: citation.source.retrievedAt ?? citation.createdAt,
          url: citation.source.finalUrl ?? citation.source.url,
          pageNumber: citation.pageNumber ?? undefined,
        },
        style
      )
    ),
    verified: Boolean(report.verifiedAt),
  };
}

/** Light markdown → plain paragraphs (bold/italics/links stripped, [n] markers kept). */
function mdToParagraphs(md: string): string[] {
  return md
    .split(/\n{2,}|\n(?=[-*#])/)
    .map((block) =>
      block
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
        .replace(/^[-*]\s+/gm, "• ")
        .trim()
    )
    .filter(Boolean);
}

function safeFilename(title: string, ext: string): string {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "report"}.${ext}`;
}

export async function buildDocxExport(
  prisma: PrismaClient,
  projectId: string,
  styleOverride?: CitationStyle
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const data = await collectExportData(prisma, projectId, styleOverride);
  const docx = await import("docx");
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Footer, PageNumber, AlignmentType } = docx;

  const children: InstanceType<typeof Paragraph>[] = [
    new Paragraph({ text: data.reportTitle, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({
          text: `${data.author} · ${data.generatedAt.toISOString().slice(0, 10)} · ${data.verified ? "citations verified against stored sources" : "CITATIONS NOT VERIFIED"}`,
          italics: true,
        }),
      ],
    }),
    new Paragraph({ text: "" }),
  ];
  for (const section of data.sections) {
    children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1 }));
    for (const para of mdToParagraphs(section.contentMd)) {
      children.push(new Paragraph({ children: [new TextRun({ text: para })] }));
    }
  }
  if (data.methodology) {
    children.push(new Paragraph({ text: "Methodology & limitations", heading: HeadingLevel.HEADING_1 }));
    for (const para of mdToParagraphs(data.methodology)) children.push(new Paragraph({ children: [new TextRun({ text: para })] }));
  }
  children.push(new Paragraph({ text: "Bibliography", heading: HeadingLevel.HEADING_1 }));
  for (const line of data.bibliography) children.push(new Paragraph({ children: [new TextRun({ text: line })] }));

  const doc = new Document({
    creator: data.author,
    title: data.reportTitle,
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES] })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  const buffer = await Packer.toBuffer(doc);
  return {
    buffer: Buffer.from(buffer),
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filename: safeFilename(data.projectTitle, "docx"),
  };
}

export async function buildPdfExport(
  prisma: PrismaClient,
  projectId: string,
  styleOverride?: CitationStyle
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const data = await collectExportData(prisma, projectId, styleOverride);
  const { default: PDFDocument } = await import("pdfkit");

  const buffer = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, bufferPages: true, info: { Title: data.reportTitle, Author: data.author } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(20).text(data.reportTitle);
    doc
      .font("Helvetica-Oblique")
      .fontSize(10)
      .text(`${data.author} · ${data.generatedAt.toISOString().slice(0, 10)} · ${data.verified ? "citations verified against stored sources" : "CITATIONS NOT VERIFIED"}`);
    doc.moveDown();
    for (const section of data.sections) {
      doc.moveDown(0.5).font("Helvetica-Bold").fontSize(14).text(section.title);
      doc.font("Helvetica").fontSize(10.5);
      for (const para of mdToParagraphs(section.contentMd)) doc.moveDown(0.35).text(para, { lineGap: 2 });
    }
    if (data.methodology) {
      doc.moveDown(0.5).font("Helvetica-Bold").fontSize(14).text("Methodology & limitations");
      doc.font("Helvetica").fontSize(9.5);
      for (const para of mdToParagraphs(data.methodology)) doc.moveDown(0.3).text(para, { lineGap: 1.5 });
    }
    doc.addPage().font("Helvetica-Bold").fontSize(14).text("Bibliography");
    doc.font("Helvetica").fontSize(9.5);
    for (const line of data.bibliography) doc.moveDown(0.35).text(line, { lineGap: 1.5 });

    // Page numbers on every page.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font("Helvetica").fontSize(8).text(`${i + 1} / ${range.count}`, 56, doc.page.height - 40, { align: "center", lineBreak: false });
    }
    doc.end();
  });

  return { buffer, mimeType: "application/pdf", filename: safeFilename(data.projectTitle, "pdf") };
}
