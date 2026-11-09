import { AnomalyEvent, AnomalyPattern, AnomalyType, MetricType } from './types';

export type StepDirection = 'rise' | 'drop';

export interface SequenceRule {
  pattern: AnomalyPattern;
  steps: MetricType[][];
  optionalMetrics?: MetricType[];
  directions?: Readonly<Partial<Record<MetricType, StepDirection>>>;
  maxSpanMs: number;
  leadMs?: Readonly<Record<number, number>>;
  sameConnection?: boolean;
  supersedes?: readonly AnomalyPattern[];
  diagnosis: string;
  recommendations: string[];
}

export type DirectedEvent = Pick<AnomalyEvent, 'metricType'> & Partial<Pick<AnomalyEvent, 'anomalyType'>>;

const DIRECTION_OF: Record<AnomalyType, StepDirection> = {
  [AnomalyType.SPIKE]: 'rise',
  [AnomalyType.DROP]: 'drop',
};

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
  const used = new Set([...rule.steps.flat(), ...(rule.optionalMetrics ?? [])]);
  for (const metric of Object.keys(rule.directions ?? {})) {
    if (!used.has(metric as MetricType)) {
      throw new Error(`Sequence rule ${rule.pattern} sets a direction on ${metric}, which it does not use`);
    }
  }
  if (rule.supersedes?.includes(rule.pattern)) {
    throw new Error(`Sequence rule ${rule.pattern} cannot supersede itself`);
  }
  if (rules.some((existing) => existing.pattern === rule.pattern)) {
    throw new Error(`Sequence rule ${rule.pattern} is already registered`);
  }
  rules.push(rule);
}

export function leadOf(rule: SequenceRule, stepIndex: number): number {
  return rule.leadMs?.[stepIndex] ?? 0;
}

export function fills(
  rule: SequenceRule,
  metrics: readonly MetricType[] | undefined,
  event: DirectedEvent,
): boolean {
  if (!metrics?.includes(event.metricType)) return false;
  const wanted = rule.directions?.[event.metricType];
  return !wanted || event.anomalyType === undefined || DIRECTION_OF[event.anomalyType] === wanted;
}

export function getSequenceRules(): readonly SequenceRule[] {
  return rules;
}
