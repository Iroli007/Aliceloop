const sessionRunChains = new Map<string, Promise<unknown>>();

function consumeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function enqueueSessionRun<T>(sessionId: string, task: () => Promise<T>) {
  const previous = sessionRunChains.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch((error) => {
      consumeError(error);
    })
    .then(task);

  sessionRunChains.set(sessionId, next);

  return next.finally(() => {
    if (sessionRunChains.get(sessionId) === next) {
      sessionRunChains.delete(sessionId);
    }
  });
}

export function getQueuedSessionCount() {
  return sessionRunChains.size;
}
