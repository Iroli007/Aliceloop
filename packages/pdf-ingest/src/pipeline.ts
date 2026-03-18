import { basename, extname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { ContentBlock, CrossReference, DocumentKind, DocumentStructure, SectionSpan } from "@aliceloop/runtime-core";

export type IngestMode = "structure-first" | "vision-assisted";

export interface DocumentDetection {
  documentKind: DocumentKind;
  rationale: string;
  suggestedMode: IngestMode;
}

export interface StructureDraft {
  structure: DocumentStructure;
  sections: SectionSpan[];
}

export interface WorkerSlice {
  id: string;
  sectionKey: string;
  title: string;
  pageFrom: number;
  pageTo: number;
  mode: IngestMode;
}

export interface WorkerPlan {
  libraryItemId: string;
  mode: IngestMode;
  slices: WorkerSlice[];
}

export interface IngestResult {
  detection: DocumentDetection;
  structureDraft: StructureDraft;
  workerPlan: WorkerPlan;
  contentBlocks: ContentBlock[];
  crossReferences: CrossReference[];
}

export interface IngestInput {
  libraryItemId: string;
  title: string;
  sourcePath: string;
  fallbackText?: string;
}

export function createWorkerPlan(
  libraryItemId: string,
  sections: SectionSpan[],
  documentKind: DocumentKind,
): WorkerPlan {
  const mode: IngestMode = documentKind === "digital" ? "structure-first" : "vision-assisted";

  return {
    libraryItemId,
    mode,
    slices: sections.map((section) => ({
      id: `${libraryItemId}:${section.key}`,
      sectionKey: section.key,
      title: section.title,
      pageFrom: section.pageFrom,
      pageTo: section.pageTo,
      mode,
    })),
  };
}

function readSourceText(sourcePath: string, fallbackText?: string) {
  if (fallbackText?.trim()) {
    return fallbackText.trim();
  }

  if (!existsSync(sourcePath)) {
    return null;
  }

  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".txt" || extension === ".md" || extension === ".markdown") {
    return readFileSync(sourcePath, "utf8").trim();
  }

  return null;
}

function detectDocumentKind(sourcePath: string, sourceText: string | null): DocumentDetection {
  const extension = extname(sourcePath).toLowerCase();
  const normalizedPath = sourcePath.toLowerCase();

  if (normalizedPath.includes("scan") || normalizedPath.includes("ocr") || extension === ".png" || extension === ".jpg") {
    return {
      documentKind: "scanned",
      rationale: "文件名或扩展名显示这更像扫描资料，需要 vision-assisted 路线。",
      suggestedMode: "vision-assisted",
    };
  }

  if (extension === ".pdf") {
    return {
      documentKind: "digital",
      rationale: sourceText
        ? "找到了可读取的伴随文本，先按 digital 文档处理。"
        : "PDF 首版先按 digital 文档处理，后续再接真正的页结构抽取。",
      suggestedMode: "structure-first",
    };
  }

  if (extension === ".txt" || extension === ".md" || extension === ".markdown" || sourceText) {
    return {
      documentKind: "digital",
      rationale: "资料正文可直接读取，适合先走 structure-first。",
      suggestedMode: "structure-first",
    };
  }

  return {
    documentKind: "hybrid",
    rationale: "资料无法直接解析正文，先建立最小结构壳，等待后续增强。",
    suggestedMode: "vision-assisted",
  };
}

function slugifySectionKey(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

function isHeadingLine(line: string) {
  const trimmed = line.trim();
  return (
    /^#{1,6}\s+/.test(trimmed) ||
    /^第[一二三四五六七八九十百千0-9]+[章节篇讲]\s*/.test(trimmed) ||
    /^[0-9]+(?:\.[0-9]+)*[\s、.．]/.test(trimmed)
  );
}

function normalizeHeading(line: string) {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[0-9]+(?:\.[0-9]+)*[\s、.．]+/, "")
    .trim();
}

function lineToPseudoPage(lineIndex: number) {
  return Math.max(1, Math.floor(lineIndex / 28) + 1);
}

function buildFallbackSections(title: string): SectionSpan[] {
  return [
    {
      key: "overview",
      title: `${title} · 概览`,
      pageFrom: 1,
      pageTo: 1,
      parentKey: null,
    },
  ];
}

function draftSectionsFromText(title: string, sourceText: string | null) {
  if (!sourceText) {
    return buildFallbackSections(title);
  }

  const lines = sourceText.split(/\r?\n/);
  const headings = lines
    .map((line, index) => ({
      index,
      title: normalizeHeading(line),
    }))
    .filter((item) => item.title && isHeadingLine(lines[item.index]));

  if (headings.length === 0) {
    return buildFallbackSections(title);
  }

  return headings.map((heading, index) => {
    const nextHeading = headings[index + 1];
    const pageFrom = lineToPseudoPage(heading.index);
    const pageTo = lineToPseudoPage((nextHeading?.index ?? lines.length) - 1);
    return {
      key: slugifySectionKey(heading.title || `section-${index + 1}`),
      title: heading.title,
      pageFrom,
      pageTo: Math.max(pageFrom, pageTo),
      parentKey: null,
    };
  });
}

function draftStructure(libraryItemId: string, title: string, sections: SectionSpan[]): StructureDraft {
  return {
    structure: {
      id: `structure-${libraryItemId}`,
      libraryItemId,
      title,
      rootSectionKeys: sections.filter((section) => !section.parentKey).map((section) => section.key),
    },
    sections,
  };
}

function summarizeSectionContent(lines: string[]) {
  const content = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  return content || "首版 ingest 已建立章节壳，等待后续正文抽取增强。";
}

function buildContentBlocks(
  libraryItemId: string,
  sections: SectionSpan[],
  sourceText: string | null,
): ContentBlock[] {
  if (!sourceText) {
    return sections.map((section, index) => ({
      id: `${libraryItemId}:block:${section.key}:${index}`,
      libraryItemId,
      sectionKey: section.key,
      sectionLabel: section.title,
      pageFrom: section.pageFrom,
      pageTo: section.pageTo,
      blockKind: "paragraph",
      content: `${section.title} 的结构壳已建立，后续会在这里补进正文和图表回链。`,
    }));
  }

  const lines = sourceText.split(/\r?\n/);
  const headingIndices = lines
    .map((line, index) => ({ index, heading: normalizeHeading(line) }))
    .filter((item) => item.heading && isHeadingLine(lines[item.index]));
  const ranges = sections.map((section, index) => {
    const headingIndex = headingIndices[index]?.index ?? 0;
    const nextHeadingIndex = headingIndices[index + 1]?.index ?? lines.length;
    return {
      section,
      start: headingIndex + 1,
      end: nextHeadingIndex,
    };
  });

  return ranges.flatMap(({ section, start, end }, sectionIndex) => {
    const sectionLines = lines.slice(start, end);
    const paragraphs = summarizeSectionContent(sectionLines)
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    return (paragraphs.length > 0 ? paragraphs : [summarizeSectionContent(sectionLines)]).map((paragraph, paragraphIndex) => ({
      id: `${libraryItemId}:block:${section.key}:${sectionIndex}-${paragraphIndex}`,
      libraryItemId,
      sectionKey: section.key,
      sectionLabel: section.title,
      pageFrom: section.pageFrom,
      pageTo: section.pageTo,
      blockKind: paragraphIndex === 0 && paragraphs.length > 1 ? "outline" : "paragraph",
      content: paragraph,
    }));
  });
}

function buildCrossReferences(libraryItemId: string, sections: SectionSpan[], contentBlocks: ContentBlock[]): CrossReference[] {
  return sections
    .map((section) => {
      const firstBlock = contentBlocks.find((block) => block.sectionKey === section.key);
      if (!firstBlock) {
        return null;
      }

      return {
        id: `xref:${libraryItemId}:${section.key}`,
        sourceKind: "section",
        sourceRef: `section:${libraryItemId}:${section.key}`,
        targetKind: "content-block",
        targetRef: firstBlock.id,
        label: section.title,
        score: 0.88,
      } satisfies CrossReference;
    })
    .filter((item): item is CrossReference => Boolean(item));
}

export function ingestDocument(input: IngestInput): IngestResult {
  const sourceText = readSourceText(input.sourcePath, input.fallbackText);
  const detection = detectDocumentKind(input.sourcePath, sourceText);
  const sections = draftSectionsFromText(input.title || basename(input.sourcePath), sourceText);
  const structureDraft = draftStructure(input.libraryItemId, input.title, sections);
  const workerPlan = createWorkerPlan(input.libraryItemId, structureDraft.sections, detection.documentKind);
  const contentBlocks = buildContentBlocks(input.libraryItemId, structureDraft.sections, sourceText);
  const crossReferences = buildCrossReferences(input.libraryItemId, structureDraft.sections, contentBlocks);

  return {
    detection,
    structureDraft,
    workerPlan,
    contentBlocks,
    crossReferences,
  };
}
