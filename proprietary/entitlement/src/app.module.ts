import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { EmailThrottlerGuard } from './common/email-throttler.guard';
import { PrismaModule } from './prisma/prisma.module';
import { EntitlementModule } from './entitlement/entitlement.module';
import { StripeModule } from './stripe/stripe.module';
import { AdminModule } from './admin/admin.module';
import { HealthModule } from './health/health.module';
import { TenantModule } from './tenant/tenant.module';
import { ProvisioningModule } from './provisioning/provisioning.module';
import { ValkeyInstanceModule } from './valkey-instance/valkey-instance.module';
import { UserModule } from './user/user.module';
import { AuthModule } from './auth/auth.module';
import { InvitationModule } from './invitation/invitation.module';
import { RegistrationModule } from './registration/registration.module';
import { EmailModule } from './email/email.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../../.env'],
    }),
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 20,
    }]),
    PrismaModule,
    HealthModule,
    EntitlementModule,
    StripeModule,
    AdminModule,
    TenantModule,
    ProvisioningModule,
    ValkeyInstanceModule,
    UserModule,
    AuthModule,
    InvitationModule,
    EmailModule,
    RegistrationModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      // Keys the public registration route on the target email (the peer IP is
      // a single shared proxy address here); all other routes keep IP tracking.
      useClass: EmailThrottlerGuard,
    },
  ],
})
export class AppModule {}
