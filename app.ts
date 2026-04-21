/**
 * @module app
 * Fastify application factory.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import helmet    from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible  from '@fastify/sensible';

import dbPlugin        from './db/client.js';
import redisPlugin     from './plugins/redis.js';
import requestIdPlugin from './plugins/request-id.js';
import metricsPlugin   from './plugins/metrics.js';
import { registerRoutes } from './routes/index.js';
import { env } from './config/env.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development' ? {
        transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
      } : {}),
      // A7: no PII — redact all token-bearing fields.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'body.client_secret',
          'body.code',
          'body.refresh_token',
          'body.access_token',
          'body.access_token_encrypted',
          'body.refresh_token_encrypted',
        ],
        censor: '[REDACTED]',
      },
    },
    // A7: use Yandex X-Request-Id as the correlation ID throughout the log chain.
    genReqId: (req) => {
      const id = req.headers['x-request-id'];
      return (typeof id === 'string' && id.length > 0) ? id : undefined!;
    },
    trustProxy: true,
  });

  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    global:     true,
    max:        env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req) => {
      const xff = req.headers['x-forwarded-for'];
      return typeof xff === 'string' ? xff.split(',')[0]!.trim() : req.ip;
    },
    errorResponseBuilder: (req, ctx) => ({
      request_id:    (req as any).requestId ?? '',
      status:        'ERROR',
      error_code:    'RATE_LIMITED',
      error_message: `Retry after ${ctx.after}`,
    }),
  });

  await app.register(requestIdPlugin);
  await app.register(metricsPlugin);     // A7
  await app.register(dbPlugin);
  await app.register(redisPlugin);

  await registerRoutes(app);

  app.setErrorHandler((error, request, reply) => {
    const requestId = request.requestId ?? '';
    if (error.validation) {
      request.log.warn({ err: error, requestId }, 'Validation error');
      return reply.code(400).send({ request_id: requestId, status: 'ERROR', error_code: 'VALIDATION_ERROR', error_message: error.message });
    }
    request.log.error({ err: error, requestId }, 'Unhandled error');
    return reply.code(500).send({ request_id: requestId, status: 'ERROR', error_code: 'INTERNAL_ERROR' });
  });

  app.setNotFoundHandler((request, reply) => {
    request.log.warn({ url: request.url, method: request.method }, '404');
    return reply.code(404).send({ request_id: request.requestId ?? '', status: 'ERROR', error_code: 'NOT_FOUND' });
  });

  return app;
}
