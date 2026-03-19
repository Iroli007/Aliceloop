import type { SafetyConfig } from "../context/index";

export class SafetyLimitError extends Error {
  public readonly reason: "max_iterations" | "timeout" | "user_abort";

  constructor(reason: SafetyLimitError["reason"], message: string) {
    super(message);
    this.name = "SafetyLimitError";
    this.reason = reason;
  }
}

export function createSafetyChecker(config: SafetyConfig) {
  let iterations = 0;
  const startTime = Date.now();

  function assertActive() {
    if (config.abortSignal.aborted) {
      throw new SafetyLimitError(
        "user_abort",
        "Agent loop aborted: user sent a new message or requested cancellation.",
      );
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > config.maxDurationMs) {
      const minutes = Math.round(config.maxDurationMs / 60_000);
      throw new SafetyLimitError(
        "timeout",
        `Agent loop stopped: exceeded time limit (${minutes} minutes).`,
      );
    }
  }

  return {
    checkStep() {
      iterations += 1;
      assertActive();

      if (iterations > config.maxIterations) {
        throw new SafetyLimitError(
          "max_iterations",
          `Agent loop stopped: reached maximum iterations (${config.maxIterations}).`,
        );
      }
    },

    checkActive() {
      assertActive();
    },

    get iterationCount() {
      return iterations;
    },

    get elapsedMs() {
      return Date.now() - startTime;
    },
  };
}
