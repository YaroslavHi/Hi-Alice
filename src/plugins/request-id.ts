/**
 * @module plugins/request-id
 *
 * Ensures every incoming request has a requestId.
 *
 * Priority:
 *  1. X-Request-Id header (sent by Yandex on every webhook call)
 *  2. Generated UUID (for requests that don't carry it)
 *
 * The requestId is attached to request.requestId and
 * echoed back in X-Request-Id response header.
 * It is also injected into every log line automatically via Fastify's genReqId.
 */

import fp from 'fastify-plugin';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';

async function requestIdPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    const incoming = request.headers['x-request-id'];
    const id = (typeof incoming === 'string' && incoming.length > 0)
      ? incoming
      : randomUUID();

    // Attach to request object (available to all handlers).
    request.requestId = id;

    // Echo back.
    reply.header('x-request-id', id);
  });
}

export default fp(requestIdPlugin, {
  name: 'request-id',
  fastify: '4.x',
});
