import { All, Controller, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { FastifyRequest, FastifyReply } from 'fastify';

const POSTHOG_HOST = process.env.POSTHOG_HOST ?? 'https://eu.i.posthog.com';

@SkipThrottle()
@Controller('ingest')
export class PosthogProxyController {
  @All('*')
  async proxy(
    @Req() req: FastifyRequest,
    @Res({ passthrough: false }) reply: FastifyReply,
  ): Promise<void> {
    // Strip everything up to and including /ingest to get the downstream path + query string
    const ingestIdx = req.url.indexOf('/ingest');
    const downstream = ingestIdx >= 0 ? req.url.slice(ingestIdx + '/ingest'.length) : '/';
    const targetUrl = `${POSTHOG_HOST}${downstream}`;

    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'content-type': (req.headers['content-type'] as string) ?? 'application/json',
      },
      body: hasBody ? JSON.stringify(req.body) : undefined,
    });

    const contentType = response.headers.get('content-type') ?? 'application/json';
    const body = await response.text();

    reply.status(response.status).header('content-type', contentType).send(body);
  }
}
