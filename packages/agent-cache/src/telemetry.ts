import { trace, type Tracer } from '@opentelemetry/api';
import {
  Counter,
  Histogram,
  Gauge,
  Registry,
  register as defaultRegistry,
  type CounterConfiguration,
  type HistogramConfiguration,
  type GaugeConfiguration,
} from 'prom-client';

interface TelemetryFactoryOptions {
  prefix: string;
  tracerName: string;
  registry?: Registry;
}

interface AgentCacheMetrics {
  requestsTotal: Counter;
  operationDuration: Histogram;
  costSaved: Counter;
  storedBytes: Counter;
  activeSessions: Gauge;
}

export interface Telemetry {
  tracer: Tracer;
  metrics: AgentCacheMetrics;
}

function getOrCreateCounter(
  registry: Registry,
  config: CounterConfiguration<string>,
): Counter {
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Counter;
  return new Counter({ ...config, registers: [registry] });
}

function getOrCreateHistogram(
  registry: Registry,
  config: HistogramConfiguration<string>,
): Histogram {
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Histogram;
  return new Histogram({ ...config, registers: [registry] });
}

function getOrCreateGauge(
  registry: Registry,
  config: GaugeConfiguration<string>,
): Gauge {
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Gauge;
  return new Gauge({ ...config, registers: [registry] });
}

export function createTelemetry(opts: TelemetryFactoryOptions): Telemetry {
  const registry = opts.registry ?? defaultRegistry;
  const tracer = trace.getTracer(opts.tracerName);

  const operationBuckets = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];

  const requestsTotal = getOrCreateCounter(registry, {
    name: `${opts.prefix}_requests_total`,
    help: 'Total agent cache requests',
    labelNames: ['cache_name', 'tier', 'result', 'tool_name'],
  });

  const operationDuration = getOrCreateHistogram(registry, {
    name: `${opts.prefix}_operation_duration_seconds`,
    help: 'Duration of agent cache operations in seconds',
    labelNames: ['cache_name', 'tier', 'operation'],
    buckets: operationBuckets,
  });

  const costSaved = getOrCreateCounter(registry, {
    name: `${opts.prefix}_cost_saved_total`,
    help: 'Estimated cost saved in dollars from cache hits',
    labelNames: ['cache_name', 'tier', 'model', 'tool_name'],
  });

  const storedBytes = getOrCreateCounter(registry, {
    name: `${opts.prefix}_stored_bytes_total`,
    help: 'Total bytes stored in cache',
    labelNames: ['cache_name', 'tier'],
  });

  const activeSessions = getOrCreateGauge(registry, {
    name: `${opts.prefix}_active_sessions`,
    help: 'Approximate number of active session threads',
    labelNames: ['cache_name'],
  });

  return {
    tracer,
    metrics: {
      requestsTotal,
      operationDuration,
      costSaved,
      storedBytes,
      activeSessions,
    },
  };
}
