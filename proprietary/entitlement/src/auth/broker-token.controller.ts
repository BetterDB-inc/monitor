import { Body, Controller, Post, UseGuards, ValidationPipe } from '@nestjs/common';
import { BrokerApiGuard } from './broker-api.guard';
import { BrokerSigningService } from './broker-signing.service';
import { BrokerTokenDto } from './dto/broker-token.dto';

@Controller('auth')
@UseGuards(BrokerApiGuard)
export class BrokerTokenController {
  constructor(private readonly brokerSigning: BrokerSigningService) {}

  @Post('broker-token')
  generateBrokerToken(@Body(new ValidationPipe({ whitelist: true })) dto: BrokerTokenDto): {
    token: string;
  } {
    return { token: this.brokerSigning.sign(dto) };
  }
}
