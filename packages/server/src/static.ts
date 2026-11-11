import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Serve the built web app (packages/web/dist) from the API server:
 *  - /assets/* (content-hashed by Vite) cached for a year, immutable;
 *  - index.html and anything else revalidated every time (no-cache, with ETag);
 *  - any other GET path that is not /api/… and not a missing asset gets index.html,
 *    so a reload on a client-side path still opens the app.
 * Does nothing when there is no build (in development Vite serves the app).
 */
export function registerWebApp(app: FastifyInstance, dist: string | undefined): boolean {
  if (!dist || !existsSync(join(dist, 'index.html'))) return false;
  app.register(fastifyStatic, {
    root: dist,
    cacheControl: false,
    setHeaders(reply, path) {
      const rel = relative(dist, path);
      reply.header(
        'Cache-Control',
        rel.startsWith(`assets${sep}`) || rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    const wantsPage =
      (req.method === 'GET' || req.method === 'HEAD') && !/^\/api(\/|$)/i.test(path) && !path.startsWith('/assets/');
    if (wantsPage) return reply.sendFile('index.html');
    return reply.status(404).send({ error: `There is nothing at ${path}.` });
  });
  return true;
}
