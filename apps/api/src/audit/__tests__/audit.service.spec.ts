import { AuditService } from '../audit.service';

describe('AuditService', () => {
  it('keeps Sentinel connections in the scheduled audit', () => {
    const service = Object.create(AuditService.prototype) as unknown as { pollsSentinels(): boolean };
    expect(service.pollsSentinels()).toBe(true);
  });
});
