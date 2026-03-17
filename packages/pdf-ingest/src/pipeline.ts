import type { ContentBlock, DocumentKind, DocumentStructure, SectionSpan } from "@aliceloop/runtime-core";

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

