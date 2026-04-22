/**
 * @module controllers/health.controller
 *
 * Health check endpoints required by Yandex Smart Home spec:
 *   GET  /v1.0  → 200 OK
 *   HEAD /v1.0  → 200 OK
 *
 * Yandex periodically pings these endpoints to verify the skill is alive.
 * They must respond within a reasonable timeout (< 5 seconds).
 * No authentication required.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

async function handleHealthGet(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.code(200).send({ status: 'ok' });
}

async function handleHealthHead(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.code(200).send();
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  // Yandex Smart Home spec: GET /v1.0 must return 200.
  app.get('/v1.0', handleHealthGet);

  // Yandex also sends HEAD /v1.0 pings.
  app.head('/v1.0', handleHealthHead);
}
