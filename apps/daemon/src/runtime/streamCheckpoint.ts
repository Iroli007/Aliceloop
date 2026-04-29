export interface StreamCheckpoint {
  sessionId: string;
  assistantMessageId: string;
  accumulatedText: string;
  timestamp: number;
}

const checkpoints = new Map<string, StreamCheckpoint>();

export function saveStreamCheckpoint(sessionId: string, assistantMessageId: string, text: string) {
  checkpoints.set(sessionId, {
    sessionId,
    assistantMessageId,
    accumulatedText: text,
    timestamp: Date.now(),
  });
}

export function getStreamCheckpoint(sessionId: string): StreamCheckpoint | null {
  const checkpoint = checkpoints.get(sessionId);
  if (!checkpoint) return null;

  // 超过5分钟的checkpoint过期
  if (Date.now() - checkpoint.timestamp > 5 * 60 * 1000) {
    checkpoints.delete(sessionId);
    return null;
  }

  return checkpoint;
}

export function clearStreamCheckpoint(sessionId: string) {
  checkpoints.delete(sessionId);
}
