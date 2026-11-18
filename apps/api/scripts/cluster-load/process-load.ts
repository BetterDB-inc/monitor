import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';

const RESOLUTION_MS = 10;
const RSS_SAMPLE_EVERY_MS = 1000;

export interface ProcessLoad {
  cpuPercent: number;
  rssPeakMb: number;
  eventLoopDelayP50Ms: number;
  eventLoopDelayP99Ms: number;
  eventLoopDelayMaxMs: number;
}

const round = (value: number): number => Number(value.toFixed(1));
const aboveTimerInterval = (nanoseconds: number): number => round(Math.max(0, nanoseconds / 1e6 - RESOLUTION_MS));

export class ProcessLoadMeter {
  private histogram: IntervalHistogram | null = null;
  private sampler: NodeJS.Timeout | null = null;
  private cpuAtStart = process.cpuUsage();
  private startedAt = performance.now();
  private rssPeak = 0;

  start(): void {
    this.stop();
    this.histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.histogram.enable();
    this.cpuAtStart = process.cpuUsage();
    this.startedAt = performance.now();
    this.rssPeak = process.memoryUsage.rss();
    this.sampler = setInterval(() => this.sampleRss(), RSS_SAMPLE_EVERY_MS);
    this.sampler.unref();
  }

  read(): ProcessLoad {
    this.sampleRss();
    const cpu = process.cpuUsage(this.cpuAtStart);
    const elapsedMs = Math.max(1, performance.now() - this.startedAt);
    const histogram = this.histogram;
    return {
      cpuPercent: round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 100),
      rssPeakMb: round(this.rssPeak / 1024 / 1024),
      eventLoopDelayP50Ms: histogram ? aboveTimerInterval(histogram.percentile(50)) : 0,
      eventLoopDelayP99Ms: histogram ? aboveTimerInterval(histogram.percentile(99)) : 0,
      eventLoopDelayMaxMs: histogram ? aboveTimerInterval(histogram.max) : 0,
    };
  }

  stop(): void {
    this.histogram?.disable();
    this.histogram = null;
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
  }

  private sampleRss(): void {
    this.rssPeak = Math.max(this.rssPeak, process.memoryUsage.rss());
  }
}
