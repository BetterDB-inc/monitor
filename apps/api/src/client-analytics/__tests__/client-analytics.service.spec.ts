import { ClientAnalyticsService } from '../client-analytics.service';

describe('ClientAnalyticsService', () => {
  it('keeps Sentinel connections in client snapshot polling', () => {
    const service = Object.create(ClientAnalyticsService.prototype) as unknown as { pollsSentinels(): boolean };
    expect(service.pollsSentinels()).toBe(true);
  });
});
