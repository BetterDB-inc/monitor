import { Controller, Get, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';

@Controller('system')
export class SystemController {
  @Get('demo')
  getDemoState(@Req() req: FastifyRequest): { demo: boolean } {
    const demoHost = process.env.DEMO_HOSTNAME;
    if (!demoHost) return { demo: false };
    return { demo: (req.headers.host || '') === demoHost };
  }
}
