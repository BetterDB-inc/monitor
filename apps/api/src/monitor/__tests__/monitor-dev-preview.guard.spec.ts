import { NotFoundException } from '@nestjs/common';
import { MonitorDevPreviewGuard } from '../monitor-dev-preview.guard';

describe('MonitorDevPreviewGuard', () => {
  const ORIGINAL_ENV = process.env.MONITOR_DEV_PREVIEW;
  let guard: MonitorDevPreviewGuard;

  beforeEach(() => {
    guard = new MonitorDevPreviewGuard();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.MONITOR_DEV_PREVIEW;
    } else {
      process.env.MONITOR_DEV_PREVIEW = ORIGINAL_ENV;
    }
  });

  it('allows the request when MONITOR_DEV_PREVIEW is "true"', () => {
    process.env.MONITOR_DEV_PREVIEW = 'true';
    expect(guard.canActivate({} as never)).toBe(true);
  });

  it('throws NotFoundException when MONITOR_DEV_PREVIEW is unset', () => {
    delete process.env.MONITOR_DEV_PREVIEW;
    expect(() => guard.canActivate({} as never)).toThrow(NotFoundException);
  });

  it('throws NotFoundException when MONITOR_DEV_PREVIEW is any value other than "true"', () => {
    for (const value of ['false', '1', 'yes', 'TRUE', '']) {
      process.env.MONITOR_DEV_PREVIEW = value;
      expect(() => guard.canActivate({} as never)).toThrow(NotFoundException);
    }
  });
});
