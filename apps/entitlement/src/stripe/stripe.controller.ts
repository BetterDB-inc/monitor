import { Controller, Post, Headers, RawBodyRequest, Req, Logger, BadRequestException } from '@nestjs/common';
import { StripeService } from './stripe.service';
import Stripe from 'stripe';

@Controller('webhooks/stripe')
export class StripeController {
  private readonly logger = new Logger(StripeController.name);

  constructor(private readonly stripe: StripeService) { }

  @Post()
  async handleWebhook(@Headers('stripe-signature') signature: string, @Req() req: RawBodyRequest<{ rawBody?: Buffer }>) {
    if (!signature || !req.rawBody) {
      throw new BadRequestException('Missing signature or body');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.constructEvent(req.rawBody, signature);
    } catch (err) {
      this.logger.error(`Webhook signature failed: ${(err as Error).message}`);
      throw new BadRequestException('Invalid signature');
    }

    this.logger.log(`Webhook: ${event.type} (${event.id})`);

    switch (event.type) {
      case 'checkout.session.completed':
        await this.stripe.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, event.id);
        break;
      case 'customer.subscription.updated':
        await this.stripe.handleSubscriptionUpdated(event.data.object as Stripe.Subscription, event.id);
        break;
      case 'customer.subscription.deleted':
        await this.stripe.handleSubscriptionDeleted(event.data.object as Stripe.Subscription, event.id);
        break;
    }

    return { received: true };
  }
}
