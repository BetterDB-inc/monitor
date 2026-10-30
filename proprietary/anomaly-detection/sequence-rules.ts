import { AnomalyPattern, MetricType } from './types';

export interface SequenceRule {
  pattern: AnomalyPattern;
  steps: MetricType[][];
  maxSpanMs: number;
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
  if (rules.some((existing) => existing.pattern === rule.pattern)) {
    throw new Error(`Sequence rule ${rule.pattern} is already registered`);
  }
  rules.push(rule);
}

export function getSequenceRules(): readonly SequenceRule[] {
  return rules;
}
