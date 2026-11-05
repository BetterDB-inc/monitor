import { AnomalyPattern, MetricType } from './types';

export interface SequenceRule {
  pattern: AnomalyPattern;
  steps: MetricType[][];
  optionalMetrics?: MetricType[];
  maxSpanMs: number;
  leadMs?: Readonly<Record<number, number>>;
  sameConnection?: boolean;
  diagnosis: string;
  recommendations: string[];
}

const rules: SequenceRule[] = [];

export function registerSequenceRule(rule: SequenceRule): void {
  if (rule.steps.length === 0 || rule.steps.some((step) => step.length === 0)) {
    throw new Error(`Sequence rule ${rule.pattern} needs at least one metric in every step`);
  }
  if (!Number.isFinite(rule.maxSpanMs) || rule.maxSpanMs <= 0) {
    throw new Error(`Sequence rule ${rule.pattern} needs a positive maxSpanMs`);
  }
  for (const [index, lead] of Object.entries(rule.leadMs ?? {})) {
    const step = Number(index);
    if (!Number.isInteger(step) || step < 1 || step >= rule.steps.length) {
      throw new Error(`Sequence rule ${rule.pattern} has a lead on step ${index}, which is not a later step`);
    }
    if (!Number.isFinite(lead) || lead <= 0) {
      throw new Error(`Sequence rule ${rule.pattern} needs a positive lead on step ${index}`);
    }
  }
  if (rules.some((existing) => existing.pattern === rule.pattern)) {
    throw new Error(`Sequence rule ${rule.pattern} is already registered`);
  }
  rules.push(rule);
}

export function leadOf(rule: SequenceRule, stepIndex: number): number {
  return rule.leadMs?.[stepIndex] ?? 0;
}

export function getSequenceRules(): readonly SequenceRule[] {
  return rules;
}
