import { Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { BulkDeleteController } from '@proprietary/bulk-delete/bulk-delete.controller';
import { AiObservabilityController } from '../../ai-observability/ai-observability.controller';
import { CveController } from '../../cve/cve.controller';
import { MetricsController } from '../../metrics/metrics.controller';
import { MonitorController } from '../../monitor/monitor.controller';
import { VectorSearchController } from '../../vector-search/vector-search.controller';
import {
  ALLOW_EXTERNAL_CONNECTION_KEY,
  HEADER_CONNECTION_ID_KEY,
  LiveConnectionGuard,
} from '../live-connection.guard';

type Expectation = 'live' | 'open';

interface ControllerCase {
  controller: Type<unknown>;
  handlers: Record<string, Expectation>;
}

const cases: ControllerCase[] = [
  {
    controller: VectorSearchController,
    handlers: {
      getSearchConfig: 'live',
      getIndexList: 'live',
      sampleKeys: 'live',
      textSearch: 'live',
      getTagValues: 'live',
      getFieldDistribution: 'live',
      profileSearch: 'live',
      search: 'live',
      getIndexInfo: 'live',
      getSnapshots: 'open',
    },
  },
  {
    controller: CveController,
    handlers: {
      getScan: 'live',
      refreshScan: 'live',
      getDataset: 'open',
    },
  },
  {
    controller: AiObservabilityController,
    handlers: {
      getInstances: 'live',
      correlateTrace: 'live',
      getHistory: 'open',
      getTraces: 'open',
      getTraceSpans: 'open',
    },
  },
  {
    controller: MonitorController,
    handlers: {
      getMonitorSupport: 'live',
      preflight: 'live',
      startSession: 'live',
      listConnectionNodes: 'live',
      createTrigger: 'live',
      createSchedule: 'live',
      evaluateHealthGate: 'open',
      listSessions: 'open',
      getSession: 'open',
      stopSession: 'open',
      crossReference: 'open',
      sessionDiff: 'open',
      exportSession: 'open',
      listTriggers: 'open',
      cancelTrigger: 'open',
      listSchedules: 'open',
      deleteSchedule: 'open',
    },
  },
  {
    controller: BulkDeleteController,
    handlers: {
      preview: 'live',
      execute: 'live',
      getJob: 'open',
      cancelJob: 'open',
      listAudits: 'open',
    },
  },
  {
    controller: MetricsController,
    handlers: {
      getSlowLog: 'live',
      getCommandLog: 'live',
      getLatestLatencyEvents: 'live',
      getClients: 'live',
      getAclLog: 'live',
      getClusterNodes: 'live',
      getClusterSlowlog: 'live',
      getInfo: 'open',
      getSlowLogPatternAnalysis: 'open',
      getCommandLogPatternAnalysis: 'open',
    },
  },
];

function guardsOn(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];
}

function isAllowed(controller: Type<unknown>, handler: object): boolean {
  return (
    Reflect.getMetadata(ALLOW_EXTERNAL_CONNECTION_KEY, handler) === true ||
    Reflect.getMetadata(ALLOW_EXTERNAL_CONNECTION_KEY, controller) === true
  );
}

function isGuarded(controller: Type<unknown>, handler: object): boolean {
  const guards = [...guardsOn(controller), ...guardsOn(handler)];
  return guards.includes(LiveConnectionGuard) && !isAllowed(controller, handler);
}

describe('live-only controllers', () => {
  const rows = cases.flatMap(({ controller, handlers }) =>
    Object.entries(handlers).map(
      ([name, expectation]) => [controller.name, name, expectation, controller] as const,
    ),
  );

  it.each(rows)(
    '%s.%s is %s for external connections',
    (_className, name, expectation, controller) => {
      const handler = (controller.prototype as Record<string, unknown>)[name];
      expect(typeof handler).toBe('function');
      expect(isGuarded(controller, handler as object)).toBe(expectation === 'live');
    },
  );

  it.each([VectorSearchController, BulkDeleteController])(
    '%p resolves the guarded connection from the header it binds',
    (controller) => {
      expect(Reflect.getMetadata(HEADER_CONNECTION_ID_KEY, controller)).toBe(true);
    },
  );
});
