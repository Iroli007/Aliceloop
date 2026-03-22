import { performance } from "node:perf_hooks";

const perfTraceEnabled = process.env.ALICELOOP_TRACE_TIMINGS?.trim() === "1";

export function nowMs() {
  return performance.now();
}

export function roundMs(value: number) {
  return Math.round(value * 10) / 10;
}

export function isPerfTraceEnabled() {
  return perfTraceEnabled;
}

export function logPerfTrace(scope: string, payload: Record<string, unknown>) {
  if (!perfTraceEnabled) {
    return;
  }

  console.info(`[aliceloop-perf] ${scope} ${JSON.stringify(payload)}`);
}
