import { runAgent } from "../runtime/agentRuntime";

export async function runProviderReply(sessionId: string) {
  return runAgent(sessionId);
}
