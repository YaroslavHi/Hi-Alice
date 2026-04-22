/**
 * @module plugins/redis
 *
 * Redis client — Fastify plugin using @fastify/redis.
 * Used for token validation cache (L1) and future pub/sub for P4 state notifications.
 */

import fp from 'fastify-plugin';
import fastifyRedis from '@fastify/redis';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

async function redisPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifyRedis, {
    url:            env.REDIS_URL,
    password:       env.REDIS_PASSWORD,
    lazyConnect:    false,
    enableOfflineQueue: false,
    connectTimeout: 5000,
  });

  app.log.info('Redis connection established');
}

export default fp(redisPlugin, {
  name: 'redis',
  fastify: '4.x',
});
