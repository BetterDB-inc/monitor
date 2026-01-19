import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { Tier, SubscriptionStatus, TIER_INSTANCE_LIMITS } from '@betterdb/shared';
import { randomBytes } from 'crypto';

const MAX_KEY_GENERATION_ATTEMPTS = 5;

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.config.get<string>('STRIPE_SECRET_KEY');
    if (!apiKey) {
      this.logger.warn('STRIPE_SECRET_KEY not set - Stripe integration disabled');
    }
    this.stripe = new Stripe(apiKey || 'sk_test_placeholder', {
      apiVersion: '2025-01-27.acacia',
    });
    this.webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET', '');
  }

  constructEvent(payload: string | Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret);
  }

  async handleCheckoutCompleted(session: Stripe.Checkout.Session, eventId: string) {
    const customerId = session.customer as string;
    const subscriptionId = session.subscription as string;

    const existing = await this.prisma.subscription.findUnique({
      where: { stripeEventId: eventId },
    });

    if (existing) {
      this.logger.debug(`Event ${eventId} already processed, skipping`);
      return;
    }

    const stripeCustomer = await this.stripe.customers.retrieve(customerId);
    if (stripeCustomer.deleted) {
      this.logger.error(`Customer ${customerId} was deleted`);
      return;
    }

    let customer = await this.prisma.customer.findUnique({
      where: { stripeId: customerId },
    });

    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          email: stripeCustomer.email!,
          name: stripeCustomer.name,
          stripeId: customerId,
        },
      });
      this.logger.log(`Created customer: ${customer.id}`);
    }

    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const priceId = subscription.items.data[0].price.id;
    const tier = this.getTierFromPriceId(priceId);

    await this.prisma.subscription.create({
      data: {
        customerId: customer.id,
        stripeSubscriptionId: subscriptionId,
        stripePriceId: priceId,
        stripeEventId: eventId,
        tier,
        status: subscription.status as SubscriptionStatus,
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
    });

    const licenseKey = await this.generateUniqueLicenseKey();
    const instanceLimit = TIER_INSTANCE_LIMITS[tier as keyof typeof TIER_INSTANCE_LIMITS] ?? 1;

    await this.prisma.license.create({
      data: {
        key: licenseKey,
        customerId: customer.id,
        tier,
        instanceLimit: Number.isFinite(instanceLimit) ? instanceLimit : 9999,
        active: true,
      },
    });

    this.logger.log(`Created license for ${customer.email}: ${licenseKey.substring(0, 8)}...`);
  }

  async handleSubscriptionUpdated(subscription: Stripe.Subscription, eventId: string) {
    const existing = await this.prisma.subscription.findFirst({
      where: { stripeSubscriptionId: subscription.id, stripeEventId: eventId },
    });

    if (existing) {
      this.logger.debug(`Event ${eventId} already processed, skipping`);
      return;
    }

    const dbSub = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId: subscription.id },
    });

    if (!dbSub) {
      this.logger.error(`Subscription not found: ${subscription.id}`);
      return;
    }

    await this.prisma.subscription.update({
      where: { id: dbSub.id },
      data: {
        status: subscription.status as SubscriptionStatus,
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        stripeEventId: eventId,
      },
    });

    if (!['active', 'trialing'].includes(subscription.status)) {
      await this.prisma.license.updateMany({
        where: { customerId: dbSub.customerId },
        data: { active: false },
      });
      this.logger.warn(`Deactivated licenses for subscription ${subscription.id}`);
    }
  }

  async handleSubscriptionDeleted(subscription: Stripe.Subscription, eventId: string) {
    const existing = await this.prisma.subscription.findFirst({
      where: { stripeSubscriptionId: subscription.id, stripeEventId: eventId },
    });

    if (existing && existing.status === SubscriptionStatus.canceled) {
      this.logger.debug(`Event ${eventId} already processed, skipping`);
      return;
    }

    const dbSub = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId: subscription.id },
    });

    if (!dbSub) {
      this.logger.error(`Subscription not found: ${subscription.id}`);
      return;
    }

    await this.prisma.subscription.update({
      where: { id: dbSub.id },
      data: { status: SubscriptionStatus.canceled, stripeEventId: eventId },
    });

    await this.prisma.license.updateMany({
      where: { customerId: dbSub.customerId },
      data: { active: false },
    });

    this.logger.warn(`Deactivated all licenses for customer ${dbSub.customerId}`);
  }

  private getTierFromPriceId(priceId: string): Tier {
    const proPrices = (this.config.get<string>('STRIPE_PRO_PRICE_IDS') || '').split(',');
    const enterprisePrices = (this.config.get<string>('STRIPE_ENTERPRISE_PRICE_IDS') || '').split(',');

    if (proPrices.includes(priceId)) return Tier.pro;
    if (enterprisePrices.includes(priceId)) return Tier.enterprise;

    this.logger.warn(`Unknown price ID: ${priceId}, defaulting to pro`);
    return Tier.pro;
  }

  private async generateUniqueLicenseKey(): Promise<string> {
    for (let attempt = 0; attempt < MAX_KEY_GENERATION_ATTEMPTS; attempt++) {
      const key = this.generateLicenseKey();
      const existing = await this.prisma.license.findUnique({ where: { key } });

      if (!existing) {
        return key;
      }

      this.logger.warn(`License key collision detected, retrying (attempt ${attempt + 1})`);
    }

    throw new Error('Failed to generate unique license key after maximum attempts');
  }

  private generateLicenseKey(): string {
    const prefix = 'btdb';
    const random = randomBytes(16).toString('hex');
    return `${prefix}_${random}`;
  }
}
