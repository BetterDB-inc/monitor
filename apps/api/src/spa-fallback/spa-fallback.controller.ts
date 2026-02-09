import { Controller, Get, Req, Res } from '@nestjs/common';
import { join } from 'path';
import { readFileSync } from 'fs';

/**
 * SPA Fallback Controller
 *
 * Catches all non-API GET routes and serves index.html for client-side routing.
 * This controller must be registered LAST in the module imports so its catch-all
 * route has lowest priority and doesn't override API routes.
 *
 * Note: This controller is only active in production mode and won't appear in API docs.
 */
@Controller()
export class SpaFallbackController {
  private readonly indexHtml: string | null = null;
  // Issue #13: Whitelist of known static file extensions
  private readonly STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt)$/i;

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      // Issue #18: Use environment variable or more maintainable path
      const publicPath = process.env.BETTERDB_STATIC_DIR
        || join(__dirname, '..', '..', '..', '..', '..', 'public');
      const indexPath = join(publicPath, 'index.html');
      this.indexHtml = readFileSync(indexPath, 'utf-8');
    }
  }

  @Get('*')
  serveSpa(
    @Req() req: any,
    @Res() reply: any
  ): void {
    // Note: Using 'any' type because @nestjs/platform-fastify doesn't export
    // FastifyRequest/Reply types directly. These are Fastify types under the hood.
    // Issue #13: Check against known static file extensions only
    const urlPath = (req.url || '').split('?')[0];
    if (this.STATIC_EXTENSIONS.test(urlPath)) {
      // Static file not found - return 404
      reply.code(404).send({ statusCode: 404, error: 'Not Found' });
      return;
    }

    // SPA fallback - serve index.html
    if (this.indexHtml) {
      reply.type('text/html').send(this.indexHtml);
    } else {
      reply.code(404).send({ statusCode: 404, error: 'Not Found' });
    }
  }
}
