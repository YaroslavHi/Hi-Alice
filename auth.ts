/**
 * @module middleware/auth
 * Validates OAuth 2.0 Bearer tokens on all /v1.0/user/* webhook endpoints.
 * Uses HMAC-SHA256 lookup (O(1) DB query) — no argon2 on the hot path.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { validateBearerToken } from '../services/token.service.js';

const BEARER_PREFIX   = 'Bearer ';
const AUTH_HEADER     = 'authorization';

function extractBearer(request: FastifyRequest): string | null {
  const h = request.headers[AUTH_HEADER];
  if (typeof h !== 'string' || !h.startsWith(BEARER_PREFIX)) return null;
  const t = h.slice(BEARER_PREFIX.length).trim();
  return t.length > 0 ? t : null;
}

export async function requireValidToken(
  request: FastifyRequest,
  reply:   FastifyReply,
): Promise<void> {
  const raw = extractBearer(request);

  if (!raw) {
    request.log.warn({ ip: request.ip, requestId: request.requestId }, 'Missing/malformed Authorization header');
    return reply.code(401).send({ request_id: request.requestId, status: 'ERROR', error_code: 'MISSING_CREDENTIALS' });
  }

  const ctx = await validateBearerToken(request.server, raw);

  if (!ctx) {
    // Deliberately not logging any part of the token — no token leaks in logs.
    request.log.warn({ ip: request.ip, requestId: request.requestId }, 'Bearer token invalid or expired');
    return reply.code(401).send({ request_id: request.requestId, status: 'ERROR', error_code: 'INVALID_TOKEN' });
  }

  request.tokenContext = ctx;
  request.log.debug(
    { linkId: ctx.access_token_id, hiHouseId: ctx.house_id, requestId: request.requestId },
    'Token validated',
  );
}
