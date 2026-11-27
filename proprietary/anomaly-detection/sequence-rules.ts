import {
  AnomalyEvent,
  AnomalyPattern,
  AnomalySeverity,
  AnomalyType,
  MetricType,
  SEVERITY_RANK,
} from './types';

export type StepDirection = 'rise' | 'drop';

export interface SequenceRule {
  pattern: AnomalyPattern;
  steps: MetricType[][];
  optionalMetrics?: MetricType[];
  directions?: Readonly<Partial<Record<MetricType, StepDirection>>>;
  /** The lowest severity at which a metric counts. An event of unknown severity does not. */
  minSeverity?: Readonly<Partial<Record<MetricType, AnomalySeverity>>>;
  maxSpanMs: number;
  leadMs?: Readonly<Record<number, number>>;
  sameConnection?: boolean;
  carriesFirstStep?: (event: StepEvidence) => boolean;
  supersedes?: readonly AnomalyPattern[];
  /** Replaced whenever this rule matches in the same incident, with or without a shared step. */
  supersedesInIncident?: readonly AnomalyPattern[];
  diagnosis: string;
  recommendations: string[];
}

export type StepEvidence = Pick<AnomalyEvent, 'metricType'> &
  Partial<Pick<AnomalyEvent, 'anomalyType' | 'retryTrigger' | 'severity'>>;

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
  for (const metric of Object.keys(rule.minSeverity ?? {})) {
    if (!used.has(metric as MetricType)) {
      throw new Error(
        `Sequence rule ${rule.pattern} sets a minimum severity on ${metric}, which it does not use`,
      );
    }
  }
  if (rule.carriesFirstStep && rule.steps.length < 2) {
    throw new Error(`Sequence rule ${rule.pattern} needs a second step to carry its first step`);
  }
  if ([...(rule.supersedes ?? []), ...(rule.supersedesInIncident ?? [])].includes(rule.pattern)) {
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

function severeEnough(rule: SequenceRule, event: StepEvidence): boolean {
  const minimum = rule.minSeverity?.[event.metricType];
  if (!minimum) return true;
  return event.severity !== undefined && SEVERITY_RANK[event.severity] >= SEVERITY_RANK[minimum];
}

export function fills(
  rule: SequenceRule,
  metrics: readonly MetricType[] | undefined,
  event: StepEvidence,
): boolean {
  if (!metrics?.includes(event.metricType) || !severeEnough(rule, event)) return false;
  const wanted = rule.directions?.[event.metricType];
  return !wanted || event.anomalyType === undefined || DIRECTION_OF[event.anomalyType] === wanted;
}

export function opensAt(rule: SequenceRule, event: StepEvidence): number | null {
  if (fills(rule, rule.steps[0], event)) return 0;
  if (rule.carriesFirstStep?.(event) && fills(rule, rule.steps[1], event)) return 1;
  return null;
}

export function getSequenceRules(): readonly SequenceRule[] {
  return rules;
}
