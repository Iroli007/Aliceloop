import { generateText } from "ai";
import { createProviderModel } from "../../providers/providerModelFactory";
import { getToolModelConfig } from "../../providers/toolModelResolver";

export async function rewriteQuery(
  originalQuery: string,
  abortSignal?: AbortSignal,
) {
  const trimmed = originalQuery.trim();
  if (!trimmed) {
    return originalQuery;
  }

  const provider = getToolModelConfig();
  if (!provider?.apiKey) {
    return originalQuery;
  }

  try {
    const response = await generateText({
      model: createProviderModel(provider),
      abortSignal,
      temperature: 0.2,
      prompt: [
        "Rewrite the following memory retrieval query to improve recall.",
        "Preserve the original intent, add concrete synonyms when helpful, and return only the rewritten query text.",
        "",
        trimmed,
      ].join("\n"),
    });

    const rewritten = response.text.trim();
    return rewritten || originalQuery;
  } catch {
    return originalQuery;
  }
}
