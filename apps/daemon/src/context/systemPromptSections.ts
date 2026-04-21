import {
  createCachedSystemPromptMessage,
  type CachedSystemPromptMessage,
} from "./cacheControl";

export interface CacheAwareSystemPromptSection {
  id: string;
  content: string;
  cacheable: boolean;
}

export function cachedSystemPromptSection(id: string, content: string): CacheAwareSystemPromptSection {
  return {
    id,
    content,
    cacheable: true,
  };
}

export function uncachedSystemPromptSection(id: string, content: string): CacheAwareSystemPromptSection {
  return {
    id,
    content,
    cacheable: false,
  };
}

interface BuildSystemPromptFromSectionsResult {
  systemPrompt: string | CachedSystemPromptMessage[];
  cachedSectionIds: string[];
  uncachedSectionIds: string[];
}

export function buildSystemPromptFromSections(
  persona: string | CachedSystemPromptMessage[],
  sections: CacheAwareSystemPromptSection[],
): BuildSystemPromptFromSectionsResult {
  const nonEmptySections = sections.filter((section) => section.content.trim());
  const cachedSections = nonEmptySections.filter((section) => section.cacheable);
  const uncachedSections = nonEmptySections.filter((section) => !section.cacheable);

  if (!Array.isArray(persona)) {
    return {
      systemPrompt: [
        persona,
        ...cachedSections.map((section) => section.content),
        ...uncachedSections.map((section) => section.content),
      ].filter(Boolean).join("\n\n"),
      cachedSectionIds: cachedSections.map((section) => section.id),
      uncachedSectionIds: uncachedSections.map((section) => section.id),
    };
  }

  const systemPrompt: CachedSystemPromptMessage[] = [...persona];
  if (cachedSections.length > 0) {
    systemPrompt.push(
      createCachedSystemPromptMessage(
        cachedSections.map((section) => section.content).join("\n\n"),
      ),
    );
  }
  if (uncachedSections.length > 0) {
    systemPrompt.push({
      role: "system",
      content: uncachedSections.map((section) => section.content).join("\n\n"),
    });
  }

  return {
    systemPrompt,
    cachedSectionIds: cachedSections.map((section) => section.id),
    uncachedSectionIds: uncachedSections.map((section) => section.id),
  };
}
