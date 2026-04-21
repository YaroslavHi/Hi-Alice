/**
 * @module index
 * Entry point: load env, build app, start notification worker, serve.
 */
import 'dotenv/config';
import { env }      from './config/env.js';
import { buildApp } from './app.js';
import { startNotificationWorker } from './services/notification.service.js';

async function main(): Promise<void> {
  const app = await buildApp();

  // A5: start background notification queue worker.
  const workerAbort = new AbortController();
  startNotificationWorker(app, workerAbort.signal);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutdown signal received');
    workerAbort.abort();
    try { await app.close(); process.exit(0); }
    catch (err) { app.log.error({ err }, 'Shutdown error'); process.exit(1); }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException',   (err)    => { app.log.fatal({ err }, 'Uncaught exception');  process.exit(1); });
  process.on('unhandledRejection',  (reason) => { app.log.fatal({ reason }, 'Unhandled rejection'); process.exit(1); });

  try { await app.listen({ port: env.PORT, host: env.HOST }); }
  catch (err) { app.log.fatal({ err }, 'Failed to start'); process.exit(1); }
}

main();
