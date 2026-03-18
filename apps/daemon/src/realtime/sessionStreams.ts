import type { SessionEvent } from "@aliceloop/runtime-core";

type SessionListener = (event: SessionEvent) => void;

const listenersBySession = new Map<string, Set<SessionListener>>();

export function publishSessionEvent(event: SessionEvent) {
  const listeners = listenersBySession.get(event.sessionId);
  if (!listeners) {
    return;
  }

  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribeToSession(sessionId: string, listener: SessionListener) {
  const listeners = listenersBySession.get(sessionId) ?? new Set<SessionListener>();
  listeners.add(listener);
  listenersBySession.set(sessionId, listeners);

  return () => {
    const current = listenersBySession.get(sessionId);
    if (!current) {
      return;
    }

    current.delete(listener);
    if (current.size === 0) {
      listenersBySession.delete(sessionId);
    }
  };
}
