export interface AttemptDecisionInput {
  attempt: number;
  maxAttempts: number;
  resolvedToolCallCount: number;
  recoveryReason: string | null;
  attemptedRecoveryReasons: Iterable<string>;
  capabilitySeekingReply: boolean;
  capabilityFailureText: string | null;
}

export type AttemptDecision =
  | { kind: "reload_context" }
  | { kind: "replace_text"; text: string }
  | { kind: "accept" };

export function decideAttemptOutcome(input: AttemptDecisionInput): AttemptDecision {
  const isLastAttempt = input.attempt >= input.maxAttempts - 1;
  const attemptedRecoveryReasons = new Set(input.attemptedRecoveryReasons);

  if (
    input.recoveryReason
    && !attemptedRecoveryReasons.has(input.recoveryReason)
    && !isLastAttempt
  ) {
    return { kind: "reload_context" };
  }

  if (
    input.resolvedToolCallCount === 0
    && input.capabilitySeekingReply
    && input.capabilityFailureText
  ) {
    return {
      kind: "replace_text",
      text: input.capabilityFailureText,
    };
  }

  return { kind: "accept" };
}
