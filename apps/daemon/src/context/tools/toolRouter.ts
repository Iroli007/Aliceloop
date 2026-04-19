import { buildTurnIntentDecision, type SkillRouteHints } from "../skills/skillRouting";

export function routeToolNamesForTurn(
  query: string | null | undefined,
  hints?: SkillRouteHints,
  options?: { hasImageAttachment?: boolean },
) {
  return buildTurnIntentDecision(query, {
    hints,
    hasImageAttachment: options?.hasImageAttachment,
  }).toolNames;
}
