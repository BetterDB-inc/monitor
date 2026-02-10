import { All, Controller, Req, Res } from '@nestjs/common';
import { join } from 'path';
import { readFileSync } from 'fs';

/**
 * SPA Fallback Controller
 * 
 * This controller MUST be registered as the LAST module in AppModule.
 * It catches all unmatched routes and serves index.html for SPA routing,
 * but only for GET requests to non-API, non-static-file routes.
 */
@Controller()
export class SpaFallbackController {
  private readonly indexHtml: string | null = null;
  private readonly STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt)$/i;

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      const publicPath = process.env.BETTERDB_STATIC_DIR
        || join(__dirname, '..', '..', '..', '..', '..', 'public');
      const indexPath = join(publicPath, 'index.html');
      this.indexHtml = readFileSync(indexPath, 'utf-8');
    }
  }

  @All('*')
  serveSpa(@Req() req: any, @Res() reply: any): void {
    const urlPath = (req.url || '').split('?')[0];

    // API routes that don't exist return JSON 404 (handled by NestJS before reaching here)
    // But double-check in case the global prefix doesn't apply
    if (urlPath.startsWith('/api/')) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found' });
      return;
    }

    // Static files that don't exist should return 404
    if (this.STATIC_EXTENSIONS.test(urlPath)) {
      reply.code(404).send({ statusCode: 404, error: 'Not Found' });
      return;
    }

    // Only serve SPA HTML for GET requests (client-side routing)
    // POST/PUT/DELETE to non-API routes should return JSON 404
    if (req.method !== 'GET') {
      reply.code(404).send({ statusCode: 404, error: 'Not Found' });
      return;
    }

    // All other GET routes (client-side routes) - serve index.html for SPA
    if (this.indexHtml) {
      reply.type('text/html').send(this.indexHtml);
    } else {
      reply.code(404).send({ statusCode: 404, error: 'Not Found' });
    }
  }
}
