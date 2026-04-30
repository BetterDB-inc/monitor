import type { Scenario } from '../types.js';
import { faqCacheBimodal } from './faq-cache-bimodal.js';
import { prodAgentThreeTools } from './prod-agent-three-tools.js';
import { agentInvalidateByTool } from './agent-invalidate-by-tool.js';
import { agentInvalidateBySession } from './agent-invalidate-by-session.js';
import { semanticInvalidateByModel } from './semantic-invalidate-by-model.js';

export const SCENARIOS: Scenario[] = [
  faqCacheBimodal,
  prodAgentThreeTools,
  agentInvalidateByTool,
  agentInvalidateBySession,
  semanticInvalidateByModel,
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
