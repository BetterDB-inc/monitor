import { HttpException, NotFoundException } from '@nestjs/common';
import { CapabilityUnavailableError } from '../../../common/errors/capability-unavailable.error';
import { Test } from '@nestjs/testing';
import { McpAiController } from '../mcp-ai.controller';
import { AiObservabilityService } from '../../../ai-observability/ai-observability.service';
import { TraceCorrelationService } from '../../../ai-observability/trace-correlation.service';
import { AgentTokenGuard } from '../../../common/guards/agent-token.guard';

describe('McpAiController', () => {
  let controller: McpAiController;
  const aiSvc = {
    getInstances: jest.fn(),
    getHistory: jest.fn(),
    getTraces: jest.fn(),
    getTraceSpans: jest.fn(),
  };
  const correlationSvc = {
    correlateTrace: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    aiSvc.getInstances.mockResolvedValue([
      { instance: { field: 'sc:demo', name: 'demo', kind: 'semantic_cache' }, latest: null },
    ]);
    aiSvc.getHistory.mockResolvedValue([]);
    aiSvc.getTraces.mockResolvedValue([]);
    aiSvc.getTraceSpans.mockResolvedValue([]);
    correlationSvc.correlateTrace.mockResolvedValue([]);
    const mod = await Test.createTestingModule({
      controllers: [McpAiController],
      providers: [
        { provide: AiObservabilityService, useValue: aiSvc },
        { provide: TraceCorrelationService, useValue: correlationSvc },
      ],
    })
      .overrideGuard(AgentTokenGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = mod.get(McpAiController);
  });

  it('GET instances returns discovered AI instances', async () => {
    const res = await controller.getInstances('inst1');
    expect(res.instances).toHaveLength(1);
    expect(aiSvc.getInstances).toHaveBeenCalledWith('inst1');
  });

  it('GET history forwards parsed hours', async () => {
    await controller.getHistory('inst1', 'sc:demo', '48');
    expect(aiSvc.getHistory).toHaveBeenCalledWith('inst1', 'sc:demo', 48);
  });

  it('GET history defaults hours to 24', async () => {
    await controller.getHistory('inst1', 'sc:demo', undefined);
    expect(aiSvc.getHistory).toHaveBeenCalledWith('inst1', 'sc:demo', 24);
  });

  it('maps capability errors to 501', async () => {
    aiSvc.getInstances.mockRejectedValueOnce(
      new CapabilityUnavailableError('AI observability is not available'),
    );
    let caught: unknown;
    try {
      await controller.getInstances('inst1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(501);
  });

  it('rethrows HttpExceptions unchanged (missing connection stays 404)', async () => {
    aiSvc.getInstances.mockRejectedValueOnce(new NotFoundException('No connection available'));
    let caught: unknown;
    try {
      await controller.getInstances('inst1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NotFoundException);
    expect((caught as HttpException).getStatus()).toBe(404);
  });

  it('maps unknown errors to 500', async () => {
    aiSvc.getInstances.mockRejectedValueOnce(new Error('boom'));
    let caught: unknown;
    try {
      await controller.getInstances('inst1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(500);
  });

  it('GET history clamps hours into [1, 168] and rounds fractions up', async () => {
    await controller.getHistory('inst1', 'sc:demo', '999999');
    expect(aiSvc.getHistory).toHaveBeenCalledWith('inst1', 'sc:demo', 168);
    await controller.getHistory('inst1', 'sc:demo', '0.5');
    expect(aiSvc.getHistory).toHaveBeenLastCalledWith('inst1', 'sc:demo', 1);
    await controller.getHistory('inst1', 'sc:demo', 'abc');
    expect(aiSvc.getHistory).toHaveBeenLastCalledWith('inst1', 'sc:demo', 24);
  });

  it('GET history downsamples large series to 200 points keeping the last sample', async () => {
    const samples = Array.from({ length: 5000 }, (unused, index) => {
      return { capturedAt: index };
    });
    aiSvc.getHistory.mockResolvedValueOnce(samples);
    const res = await controller.getHistory('inst1', 'sc:demo', undefined);
    expect(res.samples).toHaveLength(200);
    expect(res.samples[0]).toEqual({ capturedAt: 0 });
    expect(res.samples[199]).toEqual({ capturedAt: 4999 });
  });

  it('GET traces clamps hours and limit into their ranges', async () => {
    await controller.getTraces('999999', undefined, '999999');
    expect(aiSvc.getTraces).toHaveBeenCalledWith(168, undefined, 1000);
    await controller.getTraces('0', undefined, '-1');
    expect(aiSvc.getTraces).toHaveBeenLastCalledWith(1, undefined, 1);
  });

  it('GET traces treats empty query params as defaults', async () => {
    await controller.getTraces('', undefined, ' ');
    expect(aiSvc.getTraces).toHaveBeenLastCalledWith(1, undefined, 100);
  });

  it('GET traces uses defaults', async () => {
    await controller.getTraces(undefined, undefined, undefined);
    expect(aiSvc.getTraces).toHaveBeenCalledWith(1, undefined, 100);
  });

  it('GET traces forwards filters', async () => {
    await controller.getTraces('6', 'langchain', '25');
    expect(aiSvc.getTraces).toHaveBeenCalledWith(6, 'langchain', 25);
  });

  it('GET trace spans forwards traceId', async () => {
    const res = await controller.getTraceSpans('abc123');
    expect(res.spans).toEqual([]);
    expect(aiSvc.getTraceSpans).toHaveBeenCalledWith('abc123');
  });

  it('correlate passes traceId then connection id', async () => {
    const res = await controller.correlateTrace('inst1', 'abc123');
    expect(res.correlations).toEqual([]);
    expect(correlationSvc.correlateTrace).toHaveBeenCalledWith('abc123', 'inst1');
  });
});
