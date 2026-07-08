export const LEVER_ORDER = [
  'assemble',
  'temporal',
  'facts',
  'rerank-cross',
  'decompose',
  'graph',
  'preference',
] as const;

export type LeverName = (typeof LEVER_ORDER)[number];

const FLAG_BY_LEVER: Record<LeverName, string> = {
  assemble: 'LONGMEMEVAL_ASSEMBLE',
  temporal: 'LONGMEMEVAL_TEMPORAL',
  facts: 'LONGMEMEVAL_FACTS',
  'rerank-cross': 'LONGMEMEVAL_RERANK_CROSS',
  decompose: 'LONGMEMEVAL_DECOMPOSE',
  graph: 'LONGMEMEVAL_GRAPH',
  preference: 'LONGMEMEVAL_PREFERENCE',
};

function flagIsOn(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export function resolveEnabledLevers(env: Record<string, string | undefined>): LeverName[] {
  return LEVER_ORDER.filter((lever) => {
    return flagIsOn(env[FLAG_BY_LEVER[lever]]);
  });
}

export interface LeverCost {
  embedCalls?: number;
  llmCalls?: number;
  latencyMs?: number;
}

export interface LeverCostEntry {
  name: LeverName;
  embedCalls: number;
  llmCalls: number;
  latencyMs: number;
}

export interface CostReport {
  record: (lever: LeverName, cost: LeverCost) => void;
  entries: () => LeverCostEntry[];
}

export function createCostReport(): CostReport {
  const totals = new Map<LeverName, LeverCostEntry>();

  const record = (lever: LeverName, cost: LeverCost): void => {
    let entry = totals.get(lever);
    if (entry === undefined) {
      entry = { name: lever, embedCalls: 0, llmCalls: 0, latencyMs: 0 };
      totals.set(lever, entry);
    }
    entry.embedCalls += cost.embedCalls ?? 0;
    entry.llmCalls += cost.llmCalls ?? 0;
    entry.latencyMs += cost.latencyMs ?? 0;
  };

  const entries = (): LeverCostEntry[] => {
    return LEVER_ORDER.filter((lever) => totals.has(lever)).map((lever) => {
      return totals.get(lever) as LeverCostEntry;
    });
  };

  return { record, entries };
}
