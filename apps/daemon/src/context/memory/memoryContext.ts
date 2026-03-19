import { getAttentionState } from "../../repositories/overviewRepository";
import { listMemoryNotes, searchMemoryNotes } from "./memoryRepository";

export function buildMemoryBlock(sessionId: string, userQuery?: string): string {
  const sections: string[] = [];

  const attention = getAttentionState();
  if (attention.currentLibraryTitle || attention.focusSummary) {
    const attentionLines = ["## Current Attention"];
    if (attention.currentLibraryTitle) {
      attentionLines.push(`- Focused on: ${attention.currentLibraryTitle}`);
    }
    if (attention.currentSectionLabel) {
      attentionLines.push(`- Current section: ${attention.currentSectionLabel}`);
    }
    if (attention.focusSummary) {
      attentionLines.push(`- Summary: ${attention.focusSummary}`);
    }
    if (attention.concepts.length > 0) {
      attentionLines.push(`- Key concepts: ${attention.concepts.join(", ")}`);
    }
    sections.push(attentionLines.join("\n"));
  }

  const relevantNotes = userQuery
    ? searchMemoryNotes(userQuery, 5)
    : listMemoryNotes(5);

  if (relevantNotes.length > 0) {
    const memoryLines = ["## Memory Notes"];
    for (const note of relevantNotes) {
      memoryLines.push(`### ${note.title} (${note.kind})`);
      memoryLines.push(note.content);
      memoryLines.push("");
    }
    sections.push(memoryLines.join("\n"));
  }

  if (sections.length === 0) {
    return "";
  }

  return `# Context\n\n${sections.join("\n\n")}`;
}
