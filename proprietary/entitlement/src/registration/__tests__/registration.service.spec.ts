import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { RegistrationService } from '../registration.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminService } from '../../admin/admin.service';
import { EmailService } from '../../email/email.service';

const DAY_MS = 24 * 60 * 60 * 1000;

// ~3 calendar months, generous bounds (89–93 days) to absorb month lengths
function expectAboutThreeMonthsOut(date: Date) {
  const delta = date.getTime() - Date.now();
  expect(delta).toBeGreaterThan(89 * DAY_MS);
  expect(delta).toBeLessThan(93 * DAY_MS);
}

describe('RegistrationService', () => {
  let service: RegistrationService;
  let prisma: { customer: { findUnique: Mock } };
  let admin: { createCustomer: Mock; createLicense: Mock; updateLicense: Mock };
  let email: { sendRegistrationEmail: Mock };

  beforeEach(async () => {
    prisma = { customer: { findUnique: vi.fn() } };
    admin = {
      createCustomer: vi.fn().mockResolvedValue({ id: 'cust-1', email: 'new@user.test' }),
      createLicense: vi.fn().mockResolvedValue({ id: 'lic-1', key: 'btdb_newkey', tier: 'enterprise' }),
      updateLicense: vi.fn().mockResolvedValue({}),
    };
    email = { sendRegistrationEmail: vi.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RegistrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminService, useValue: admin },
        { provide: EmailService, useValue: email },
      ],
    }).compile();

    service = module.get(RegistrationService);
  });

  it('normalizes email casing before lookup and creation', async () => {
    prisma.customer.findUnique.mockResolvedValue(null);

    await service.register('  MiXeD@User.Test ');

    expect(prisma.customer.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'mixed@user.test' } }),
    );
    expect(admin.createCustomer).toHaveBeenCalledWith({ email: 'mixed@user.test' });
    expect(email.sendRegistrationEmail).toHaveBeenCalledWith('mixed@user.test', 'btdb_newkey');
  });

  it('creates a 3-month enterprise license for new registrations', async () => {
    prisma.customer.findUnique.mockResolvedValue(null);

    await service.register('new@user.test');

    expect(admin.createLicense).toHaveBeenCalledTimes(1);
    const args = admin.createLicense.mock.calls[0][0];
    expect(args.tier).toBe('enterprise');
    expect(args.expiresAt).toBeInstanceOf(Date);
    expectAboutThreeMonthsOut(args.expiresAt);
    expect(email.sendRegistrationEmail).toHaveBeenCalledWith('new@user.test', 'btdb_newkey');
  });

  it('renews a soon-expiring self-serve license for another 3 months on re-registration', async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 'cust-1',
      email: 'old@user.test',
      licenses: [
        {
          id: 'lic-old',
          key: 'btdb_oldkey',
          tier: 'enterprise',
          active: true,
          expiresAt: new Date(Date.now() + 10 * DAY_MS),
        },
      ],
    });

    await service.register('old@user.test');

    expect(admin.createLicense).not.toHaveBeenCalled();
    expect(admin.updateLicense).toHaveBeenCalledTimes(1);
    const [id, update] = admin.updateLicense.mock.calls[0];
    expect(id).toBe('lic-old');
    expectAboutThreeMonthsOut(update.expiresAt);
    expect(email.sendRegistrationEmail).toHaveBeenCalledWith('old@user.test', 'btdb_oldkey');
  });

  it('never adds an expiry to a perpetual (paid) license on re-registration', async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 'cust-1',
      email: 'paid@user.test',
      licenses: [
        { id: 'lic-paid', key: 'btdb_paidkey', tier: 'enterprise', active: true, expiresAt: null },
      ],
    });

    await service.register('paid@user.test');

    expect(admin.updateLicense).not.toHaveBeenCalled();
    expect(admin.createLicense).not.toHaveBeenCalled();
    expect(email.sendRegistrationEmail).toHaveBeenCalledWith('paid@user.test', 'btdb_paidkey');
  });

  it('never shortens a license that expires later than the renewal window', async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 'cust-1',
      email: 'annual@user.test',
      licenses: [
        {
          id: 'lic-annual',
          key: 'btdb_annualkey',
          tier: 'enterprise',
          active: true,
          expiresAt: new Date(Date.now() + 365 * DAY_MS),
        },
      ],
    });

    await service.register('annual@user.test');

    expect(admin.updateLicense).not.toHaveBeenCalled();
    expect(email.sendRegistrationEmail).toHaveBeenCalledWith('annual@user.test', 'btdb_annualkey');
  });

  it('renews (un-expires) a lapsed but active license on re-registration', async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 'cust-1',
      email: 'lapsed@user.test',
      licenses: [
        {
          id: 'lic-lapsed',
          key: 'btdb_lapsedkey',
          tier: 'enterprise',
          active: true,
          expiresAt: new Date(Date.now() - 30 * DAY_MS),
        },
      ],
    });

    await service.register('lapsed@user.test');

    expect(admin.updateLicense).toHaveBeenCalledTimes(1);
    expectAboutThreeMonthsOut(admin.updateLicense.mock.calls[0][1].expiresAt);
  });

  it('creates a fresh 3-month license when only deactivated licenses exist', async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 'cust-1',
      email: 'revoked@user.test',
      licenses: [
        { id: 'lic-dead', key: 'btdb_deadkey', tier: 'enterprise', active: false },
      ],
    });

    await service.register('revoked@user.test');

    expect(admin.updateLicense).not.toHaveBeenCalled();
    expect(admin.createLicense).toHaveBeenCalledTimes(1);
    expectAboutThreeMonthsOut(admin.createLicense.mock.calls[0][0].expiresAt);
  });
});
