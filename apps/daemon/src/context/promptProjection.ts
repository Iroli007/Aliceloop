import { computeSkillBlockKey } from "./skills/skillLoader";

export interface PromptProjectionMessage {
  role: "system";
  content: string;
  providerOptions?: {
    anthropic?: {
      cacheControl?: {
        type: "ephemeral";
      };
    };
  };
}

export interface PromptProjectionBlock {
  id: string;
  content: string;
  cacheControl?: "ephemeral";
}

export interface PromptProjection {
  systemPrompt: PromptProjectionMessage[];
  stablePrefixParts: PromptProjectionBlock[];
  volatileSuffixParts: PromptProjectionBlock[];
  stablePrefixKey: string | null;
  volatileSuffixKey: string | null;
}

function toProjectionBlock(
  id: string,
  message: PromptProjectionMessage,
): PromptProjectionBlock {
  return {
    id,
    content: message.content,
    cacheControl: message.providerOptions?.anthropic?.cacheControl?.type === "ephemeral"
      ? "ephemeral"
      : undefined,
  };
}

export function buildPromptProjection(input: {
  persona: PromptProjectionMessage[];
  stableBlocks: PromptProjectionBlock[];
  volatileBlocks: PromptProjectionBlock[];
}): PromptProjection {
  const stablePrefixParts = [
    ...input.persona.map((message, index) => toProjectionBlock(`persona:${index}`, message)),
    ...input.stableBlocks.filter((block) => block.content.trim()),
  ];
  const volatileSuffixParts = input.volatileBlocks.filter((block) => block.content.trim());

  const systemPrompt = [
    ...stablePrefixParts.map((part) => ({
      role: "system" as const,
      content: part.content,
      ...(part.cacheControl === "ephemeral"
        ? {
            providerOptions: {
              anthropic: {
                cacheControl: {
                  type: "ephemeral" as const,
                },
              },
            },
          }
        : {}),
    })),
    ...volatileSuffixParts.map((part) => ({
      role: "system" as const,
      content: part.content,
    })),
  ];

  const stablePrefixContent = stablePrefixParts.map((part) => part.content).join("\n\n");
  const volatileSuffixContent = volatileSuffixParts.map((part) => part.content).join("\n\n");

  return {
    systemPrompt,
    stablePrefixParts,
    volatileSuffixParts,
    stablePrefixKey: stablePrefixContent ? computeSkillBlockKey(stablePrefixContent) : null,
    volatileSuffixKey: volatileSuffixContent ? computeSkillBlockKey(volatileSuffixContent) : null,
  };
}
