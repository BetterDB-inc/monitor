import { McpModule } from '../mcp.module';
import { McpInsightsController } from '../mcp-insights.controller';
import { McpMonitorController } from '../mcp-monitor.controller';
import { ScalingReadinessModule } from '../../scaling-readiness/scaling-readiness.module';
import { CveModule } from '../../cve/cve.module';
import { FleetModule } from '../../fleet/fleet.module';
import { MonitorModule } from '../../monitor/monitor.module';
import { MonitorCaptureService } from '../../monitor/monitor-capture.service';
import { CrossReferenceEngine } from '../../monitor/cross-reference.engine';
import { CacheSimulatorModule } from '@proprietary/cache-simulator/cache-simulator.module';
import { McpCacheSimulatorController } from '@proprietary/cache-simulator/mcp-cache-simulator.controller';
import { KeyAnalyticsModule } from '@proprietary/key-analytics/key-analytics.module';
import { McpKeyAnalyticsController } from '@proprietary/key-analytics/mcp-key-analytics.controller';
import { KvCacheModule } from '@proprietary/kv-cache/kv-cache.module';
import { McpKvCacheController } from '@proprietary/kv-cache/mcp-kv-cache.controller';
import { ScalingReadinessProModule } from '@proprietary/scaling-readiness-pro/scaling-readiness-pro.module';
import { McpScalingReadinessController } from '@proprietary/scaling-readiness-pro/mcp-scaling-readiness.controller';

// Metadata-level wiring checks: they need no database or running Nest app, but
// fail if a controller or a provider the MCP routes depend on is dropped from
// a module (Nest would otherwise only report it at boot).
describe('MCP module wiring', () => {
  it('McpModule registers the insights and monitor controllers', () => {
    const controllers = Reflect.getMetadata('controllers', McpModule);
    expect(controllers).toEqual(expect.arrayContaining([McpInsightsController, McpMonitorController]));
  });

  it('McpModule imports the modules that provide their services', () => {
    const imports = Reflect.getMetadata('imports', McpModule);
    expect(imports).toEqual(
      expect.arrayContaining([ScalingReadinessModule, CveModule, FleetModule, MonitorModule]),
    );
  });

  it('MonitorModule exports the singletons McpModule reuses', () => {
    const exports = Reflect.getMetadata('exports', MonitorModule);
    expect(exports).toEqual(expect.arrayContaining([MonitorCaptureService, CrossReferenceEngine]));
  });

  it.each([
    ['CacheSimulatorModule', CacheSimulatorModule, McpCacheSimulatorController],
    ['KeyAnalyticsModule', KeyAnalyticsModule, McpKeyAnalyticsController],
    ['KvCacheModule', KvCacheModule, McpKvCacheController],
    ['ScalingReadinessProModule', ScalingReadinessProModule, McpScalingReadinessController],
  ])('%s lists its MCP controller', (_name, module, controller) => {
    expect(Reflect.getMetadata('controllers', module)).toContain(controller);
  });
});
