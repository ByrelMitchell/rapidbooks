import type { FastifyInstance } from 'fastify';
import { createReadStream, unlinkSync } from 'node:fs';
import { AppError } from '../errors';
import type { BackupService } from './service';

/** POST /api/backup, GET /api/backup/status, GET /api/backup/download. */
export function registerBackupRoutes(app: FastifyInstance, backup: BackupService) {
  app.post('/api/backup', async () => {
    try {
      const r = await backup.run();
      return { file: r.file, size: r.size, durationMs: r.durationMs, at: r.at, directory: backup.dir };
    } catch (e) {
      throw new AppError(500, (e as Error).message);
    }
  });

  app.get('/api/backup/status', () => backup.status());

  // A freshly made, verified copy, streamed as an attachment (File > Back Up > Save a Copy).
  app.get('/api/backup/download', async (_req, reply) => {
    let copy: { path: string; file: string; size: number };
    try {
      copy = await backup.makeDownloadCopy();
    } catch (e) {
      throw new AppError(500, `A copy could not be made: ${(e as Error).message}`);
    }
    const stream = createReadStream(copy.path);
    const cleanup = () => {
      try {
        unlinkSync(copy.path);
      } catch {
        // already gone
      }
    };
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    return reply
      .header('Content-Type', 'application/vnd.sqlite3')
      .header('Content-Length', String(copy.size))
      .header('Content-Disposition', `attachment; filename="${copy.file}"`)
      .header('Cache-Control', 'no-store')
      .send(stream);
  });
}
