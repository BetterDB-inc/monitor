import { Logger } from '@nestjs/common';
import { webhookNetworkPolicy, webhookPrivateHint } from '../webhook-network-policy';

describe('webhookNetworkPolicy', () => {
  const env = { ...process.env };

  beforeEach(() => {
    delete process.env.CLOUD_MODE;
    delete process.env.WEBHOOK_ALLOWED_PRIVATE_CIDRS;
    delete process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS;
  });

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('allows nothing by default', () => {
    expect(webhookNetworkPolicy()).toBeUndefined();
    process.env.WEBHOOK_ALLOWED_PRIVATE_CIDRS = ' ';
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = '';
    expect(webhookNetworkPolicy()).toBeUndefined();
  });

  it('builds the policy from both variables and reuses it', () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_CIDRS = '10.244.0.0/16';
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = '*.svc.cluster.local';
    const policy = webhookNetworkPolicy();
    expect(policy?.allowedCidrs?.check('10.244.1.7')).toBe(true);
    expect(policy?.allowedCidrs?.check('10.245.0.1')).toBe(false);
    expect(policy?.allowedHosts).toEqual(['*.svc.cluster.local']);
    expect(webhookNetworkPolicy()).toBe(policy);
  });

  it('builds a policy from either variable alone', () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = 'relay.internal';
    expect(webhookNetworkPolicy()).toEqual({ allowedCidrs: undefined, allowedHosts: ['relay.internal'] });
  });

  it('ignores both variables in cloud mode and names them in a warning', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.CLOUD_MODE = 'true';
    process.env.WEBHOOK_ALLOWED_PRIVATE_CIDRS = '10.244.0.0/16';
    process.env.WEBHOOK_ALLOWED_PRIVATE_HOSTS = '*.svc.cluster.local';
    expect(webhookNetworkPolicy()).toBeUndefined();
    expect(webhookNetworkPolicy()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('WEBHOOK_ALLOWED_PRIVATE_CIDRS');
    expect(warn.mock.calls[0][0]).toContain('WEBHOOK_ALLOWED_PRIVATE_HOSTS');
    expect(webhookPrivateHint()).toBeUndefined();
  });

  it('does not warn in cloud mode when neither variable is set', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.CLOUD_MODE = 'true';
    expect(webhookNetworkPolicy()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('fails on an invalid entry instead of dropping it', () => {
    process.env.WEBHOOK_ALLOWED_PRIVATE_CIDRS = '10.244.0.0/16,0.0.0.0/0';
    expect(() => webhookNetworkPolicy()).toThrow('overlaps a cloud metadata or link-local range');
  });

  it('points self-hosted operators at the two variables', () => {
    expect(webhookPrivateHint()).toContain('WEBHOOK_ALLOWED_PRIVATE_CIDRS or WEBHOOK_ALLOWED_PRIVATE_HOSTS');
  });
});
