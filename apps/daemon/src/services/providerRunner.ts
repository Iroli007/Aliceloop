import { getActiveProviderConfig } from "../repositories/providerRepository";
import { runMiniMaxReply } from "./minimaxRunner";
import { enqueueSessionRun } from "./sessionRunQueue";

export async function runProviderReply(sessionId: string) {
  return enqueueSessionRun(sessionId, async () => {
    const activeProvider = getActiveProviderConfig();

    if (!activeProvider) {
      return runMiniMaxReply(sessionId);
    }

    switch (activeProvider.id) {
      case "minimax":
        return runMiniMaxReply(sessionId);
      default:
        throw new Error(`Unsupported provider: ${activeProvider.id}`);
    }
  });
}
