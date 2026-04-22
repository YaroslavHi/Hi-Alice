/**
 * @module controllers/unlink.controller
 * POST /v1.0/user/unlink — Yandex account unlink.
 * Sets link_status='unlinked'; future tokens for this link are rejected.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireValidToken } from '../middleware/auth.js';
import { unlinkAccount }     from '../services/token.service.js';
import type { UnlinkResponse } from '../types/yandex.js';

async function handleUnlink(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.tokenContext!;
  await unlinkAccount(req.server, token, req.ip, req.requestId);
  return reply.code(200).send({ request_id: req.requestId } satisfies UnlinkResponse);
}

export async function registerUnlinkRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1.0/user/unlink', { preHandler: [requireValidToken] }, handleUnlink);
}
