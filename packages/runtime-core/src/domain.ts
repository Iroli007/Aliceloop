export type DocumentKind = "digital" | "hybrid" | "scanned";
export type SourceKind = "book" | "web" | "handout";
export type ArtifactKind = "study-page" | "topic-page" | "review-pack";
export type TaskStatus = "queued" | "running" | "done" | "failed";
export type MemoryKind = "attention-summary" | "learning-pattern" | "postmortem";
export type BlockKind = "outline" | "paragraph" | "figure-caption" | "table";

export interface LibraryItem {
  id: string;
  title: string;
  sourceKind: SourceKind;
  documentKind: DocumentKind;
  sourcePath: string | null;
  createdAt: string;
  updatedAt: string;
  lastAttentionLabel: string | null;
}

export interface StudyArtifact {
  id: string;
  libraryItemId: string;
  kind: ArtifactKind;
  title: string;
  summary: string;
  relatedLibraryTitle: string;
  updatedAt: string;
  updatedAtLabel: string;
}

export interface TaskRun {
  id: string;
  taskType: "document-ingest" | "study-artifact" | "review-coach" | "local-script-runner";
  status: TaskStatus;
  title: string;
  updatedAt: string;
  updatedAtLabel: string;
}

export interface AttentionEvent {
  id: string;
  libraryItemId: string;
  sectionKey: string | null;
  conceptKey: string | null;
  reason: string;
  weight: number;
  occurredAt: string;
}

export interface AttentionState {
  id: string;
  currentLibraryItemId: string | null;
  currentLibraryTitle: string | null;
  currentSectionKey: string | null;
  currentSectionLabel: string | null;
  focusSummary: string;
  concepts: string[];
  updatedAt: string;
  events: AttentionEvent[];
}

export interface MemoryNote {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  source: string;
  updatedAt: string;
}

export interface DocumentStructure {
  id: string;
  libraryItemId: string;
  title: string;
  rootSectionKeys: string[];
}

export interface SectionSpan {
  key: string;
  title: string;
  pageFrom: number;
  pageTo: number;
  parentKey: string | null;
}

export interface ContentBlock {
  id: string;
  libraryItemId: string;
  sectionKey: string;
  sectionLabel: string;
  pageFrom: number;
  pageTo: number;
  blockKind: BlockKind;
  content: string;
}

export interface CrossReference {
  id: string;
  sourceKind: string;
  sourceRef: string;
  targetKind: string;
  targetRef: string;
  label: string;
  score: number;
}

export interface ShellOverview {
  library: LibraryItem[];
  artifacts: StudyArtifact[];
  attention: AttentionState;
  memories: MemoryNote[];
  taskRuns: TaskRun[];
}

export const shellOverviewRoute = "/api/shell/overview";

