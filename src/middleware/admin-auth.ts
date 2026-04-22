import type { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';

export async function requireAdminKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = request.headers['x-admin-key'];
  if (!key || key !== env.ADMIN_API_KEY) {
    request.log.warn({ ip: request.ip }, 'Unauthorized admin API call');
    await reply.code(401).send({ error: 'unauthorized' });
  }
}
