import { Body, Controller, Post, UseGuards, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { BrokerApiGuard } from './broker-api.guard';
import { BrokerThrottlerGuard } from './broker-throttler.guard';
import { BrokerSigningService } from './broker-signing.service';
import { BrokerTokenDto } from './dto/broker-token.dto';

@Controller('auth')
@UseGuards(BrokerApiGuard, BrokerThrottlerGuard)
export class BrokerTokenController {
  constructor(private readonly brokerSigning: BrokerSigningService) {}

  @Post('broker-token')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  generateBrokerToken(@Body(new ValidationPipe({ whitelist: true })) dto: BrokerTokenDto): {
    token: string;
  } {
    return { token: this.brokerSigning.sign(dto) };
  }
}
