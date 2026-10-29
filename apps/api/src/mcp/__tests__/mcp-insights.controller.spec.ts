import { HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { McpInsightsController } from '../mcp-insights.controller';
import { AgentTokenGuard } from '../../common/guards/agent-token.guard';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { CveService } from '../../cve/cve.service';
import { FleetService } from '../../fleet/fleet.service';
import { ScalingReadinessService } from '../../scaling-readiness/scaling-readiness.service';

describe('McpInsightsController', () => {
  const registry = { get: jest.fn() };
  const readiness = { compute: jest.fn() };
  const cve = { getScan: jest.fn(), getDataset: jest.fn() };
  const fleet = { getSummary: jest.fn() };
  let controller: McpInsightsController;

  beforeEach(async () => {
    jest.clearAllMocks();
    registry.get.mockReturnValue({});
    readiness.compute.mockResolvedValue({ connectionId: 'inst1', score: 72, band: 'amber', dimensions: [] });
    cve.getScan.mockResolvedValue({ connectionId: 'inst1', nodes: [], partial: false });
    cve.getDataset.mockResolvedValue({ datasetVersion: 'v1', healthy: true });
    fleet.getSummary.mockResolvedValue({ overallStatus: 'healthy', instances: [], timestamp: 1 });
    const mod = await Test.createTestingModule({
      controllers: [McpInsightsController],
      providers: [
        { provide: ConnectionRegistry, useValue: registry },
        { provide: ScalingReadinessService, useValue: readiness },
        { provide: CveService, useValue: cve },
        { provide: FleetService, useValue: fleet },
      ],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpInsightsController);
  });

  describe('getScalingReadiness', () => {
    it('validates the instance then returns the computed score', async () => {
      const res = await controller.getScalingReadiness('inst1');
      expect(registry.get).toHaveBeenCalledWith('inst1');
      expect(readiness.compute).toHaveBeenCalledWith('inst1');
      expect(res.score).toBe(72);
    });

    it('propagates 404 for an unknown instance without computing', async () => {
      registry.get.mockImplementationOnce(() => {
        throw new NotFoundException("Connection 'nope' not found");
      });
      await expect(controller.getScalingReadiness('nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(readiness.compute).not.toHaveBeenCalled();
    });

    it('maps unexpected service failures to 500', async () => {
      readiness.compute.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.getScalingReadiness('inst1')).rejects.toMatchObject({ status: 500 });
    });
  });

  describe('getCveExposure', () => {
    it('returns the scan together with dataset health', async () => {
      const res = await controller.getCveExposure('inst1');
      expect(cve.getScan).toHaveBeenCalledWith('inst1');
      expect(cve.getDataset).toHaveBeenCalledTimes(1);
      expect(res).toEqual({
        scan: { connectionId: 'inst1', nodes: [], partial: false },
        dataset: { datasetVersion: 'v1', healthy: true },
      });
    });

    it('passes the 503 through unchanged when CVE inspection is disabled', async () => {
      const disabled = new ServiceUnavailableException('CVE inspection is turned off on this install (CVE_ENABLED=false), so nothing was scanned.');
      cve.getScan.mockRejectedValueOnce(disabled);
      let caught: unknown;
      try {
        await controller.getCveExposure('inst1');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(disabled);
      expect((caught as HttpException).getStatus()).toBe(503);
    });
  });

  describe('getFleetSummary', () => {
    it('returns the fleet summary without needing an instance', async () => {
      const res = await controller.getFleetSummary();
      expect(res.overallStatus).toBe('healthy');
      expect(registry.get).not.toHaveBeenCalled();
    });

    it('maps failures to 500', async () => {
      fleet.getSummary.mockRejectedValueOnce(new Error('boom'));
      await expect(controller.getFleetSummary()).rejects.toMatchObject({ status: 500 });
    });
  });

  it('is rate-limited to 10 requests per minute', () => {
    const fn = McpInsightsController.prototype.getCveExposure;
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, fn)).toBe(10);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, fn)).toBe(60000);
  });
});
