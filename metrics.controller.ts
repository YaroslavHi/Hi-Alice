/**
 * @module controllers/metrics.controller
 * GET /metrics — Prometheus text exposition (A7).
 * Should be protected at the network layer (not exposed to Yandex or public internet).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

async function handleMetrics(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  return reply
    .code(200)
    .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    .send(req.server.metrics.render());
}

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics', handleMetrics);
}
