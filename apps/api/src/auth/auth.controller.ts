import { Controller, Get, Query, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';

@Controller('auth')
export class AuthCallbackController {
  @Get('callback')
  handleCallback(@Query('token') token: string, @Res() reply: FastifyReply) {
    // OSS: no-op, just redirect to root
    reply.redirect('/');
  }
}
