/**
 * @module controllers/oauth.controller
 * OAuth 2.0 Authorization Code Grant for Yandex Smart Home account linking.
 *
 * Flow:
 *  1. Yandex → GET /oauth/authorize       (redirect user to HI login)
 *  2. HI auth → GET /oauth/callback       (user authenticated; issue auth code)
 *  3. Yandex → POST /oauth/token          (exchange code → token pair)
 *  4. Yandex → POST /oauth/token          (refresh_token grant → new pair)
 *
 * Security:
 *  - Tokens encrypted at rest (AES-256-GCM) in alice_account_links
 *  - HMAC-SHA256 for O(1) validation lookup
 *  - Auth codes: HMAC-only (verify-only, never retrieved)
 *  - redirect_uri validated against yandex.ru / yandex.net
 *  - One active link per house; new link replaces old (UPSERT)
 *  - NO tokens appear in any log line
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env }                                        from '../config/env.js';
import { generateAuthCode, storeAuthCode, consumeAuthCode, issueTokenPair, rotateRefreshToken } from '../services/token.service.js';
import type { OAuthTokenResponse, OAuthTokenErrorResponse } from '../types/yandex.js';

// ─── Validators ───────────────────────────────────────────────────────────────

const authorizeQuerySchema = z.object({
  response_type: z.literal('code'),
  client_id:     z.string().min(1),
  redirect_uri:  z.string().url(),
  state:         z.string().optional(),
  scope:         z.string().optional(),
});

const callbackQuerySchema = z.object({
  hi_user_id:        z.string().min(1),
  hi_house_id:       z.string().min(1),
  yandex_user_id:    z.string().min(1),
  yandex_state:      z.string().default(''),
  yandex_redirect_uri: z.string().url(),
});

const tokenBodySchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type:    z.literal('authorization_code'),
    code:          z.string().min(1),
    client_id:     z.string().min(1),
    client_secret: z.string().min(1),
    redirect_uri:  z.string().url(),
  }),
  z.object({
    grant_type:    z.literal('refresh_token'),
    refresh_token: z.string().min(1),
    client_id:     z.string().min(1),
    client_secret: z.string().min(1),
  }),
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateClient(clientId: string, clientSecret: string): boolean {
  // Both branches always execute — mild constant-time-ish comparison.
  const idOk = clientId === env.YANDEX_CLIENT_ID;
  const skOk = clientSecret === env.YANDEX_CLIENT_SECRET;
  return idOk && skOk;
}

function sendTokenError(reply: FastifyReply, error: OAuthTokenErrorResponse['error'], desc?: string): void {
  void reply.code(400).send({ error, ...(desc !== undefined ? { error_description: desc } : {}) });
}

/**
 * Exact allowlist of permitted OAuth redirect URIs.
 * Populated once at startup from the YANDEX_REDIRECT_URI_ALLOWLIST env var
 * (comma-separated list of exact HTTPS URIs).
 *
 * Replaces the broad hostname suffix check (*.yandex.ru / *.yandex.net) which
 * could permit open-redirect via attacker-controlled Yandex subdomains.
 */
const REDIRECT_URI_ALLOWLIST: ReadonlySet<string> = new Set(
  env.YANDEX_REDIRECT_URI_ALLOWLIST.split(',').map((u) => u.trim()).filter(Boolean),
);

function validateRedirectUri(uri: string): boolean {
  return REDIRECT_URI_ALLOWLIST.has(uri);
}

// ─── GET /oauth/authorize ─────────────────────────────────────────────────────

async function handleAuthorize(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = authorizeQuerySchema.safeParse(req.query);
  if (!r.success) {
    req.log.warn({ issues: r.error.issues }, 'Invalid /authorize params');
    return reply.code(400).send('Invalid OAuth request');
  }
  const { client_id, redirect_uri, state, scope } = r.data;
  if (client_id !== env.YANDEX_CLIENT_ID) {
    req.log.warn({ clientId: client_id }, 'Unknown client_id in /authorize');
    return reply.code(400).send('Unknown client_id');
  }

  // Build HI login URL — HI auth will call /oauth/callback after user authenticates.
  const loginUrl = new URL(env.HI_LOGIN_URL);
  loginUrl.searchParams.set('redirect_back',    `${env.SERVICE_BASE_URL}/oauth/callback`);
  loginUrl.searchParams.set('yandex_redirect',  redirect_uri);
  loginUrl.searchParams.set('yandex_state',     state ?? '');
  if (scope) loginUrl.searchParams.set('scope', scope);

  req.log.info({ clientId: client_id }, '/authorize — redirecting to HI login');
  return reply.redirect(302, loginUrl.toString());
}

// ─── GET /oauth/callback ──────────────────────────────────────────────────────

async function handleCallback(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = callbackQuerySchema.safeParse(req.query);
  if (!r.success) {
    req.log.warn({ issues: r.error.issues }, 'Invalid /callback params');
    return reply.code(400).send('Invalid callback parameters');
  }
  const { hi_user_id, hi_house_id, yandex_user_id, yandex_state, yandex_redirect_uri } = r.data;

  if (!validateRedirectUri(yandex_redirect_uri)) {
    req.log.warn({ uri: yandex_redirect_uri }, 'redirect_uri not in allowlist — rejected');
    return reply.code(400).send('Invalid redirect_uri');
  }

  // Store auth code — HMAC of the raw code stored in DB.
  const rawCode = generateAuthCode();
  await storeAuthCode(req.server, {
    rawCode,
    clientId:         env.YANDEX_CLIENT_ID,
    hiHouseId:        hi_house_id,
    hiOwnerAccountId: hi_user_id,
    redirectUri:      yandex_redirect_uri,
  });

  // We store yandex_user_id in a Redis session keyed by code HMAC — used during token exchange.
  // This avoids an extra DB column while keeping the data available for 10 min.
  const { computeCodeHmac } = await import('../services/crypto.service.js');
  const codeHmac = computeCodeHmac(rawCode);
  try {
    await req.server.redis.setex(
      `alice:authcode:meta:${codeHmac}`,
      env.AUTH_CODE_TTL_SECONDS,
      JSON.stringify({ yandex_user_id }),
    );
  } catch (err) {
    req.log.warn({ err }, 'Failed to cache yandex_user_id for code — will fall back');
  }

  const redirectUrl = new URL(yandex_redirect_uri);
  redirectUrl.searchParams.set('code',  rawCode);
  redirectUrl.searchParams.set('state', yandex_state);

  req.log.info({ hiHouseId: hi_house_id, hiUserId: hi_user_id }, 'Auth code issued → redirect to Yandex');
  return reply.redirect(302, redirectUrl.toString());
}

// ─── POST /oauth/token ────────────────────────────────────────────────────────

async function handleToken(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = tokenBodySchema.safeParse(req.body);
  if (!r.success) {
    req.log.warn({ issues: r.error.issues }, 'Invalid /token body');
    sendTokenError(reply, 'invalid_request', 'Missing or invalid parameters');
    return;
  }

  if (!validateClient(r.data.client_id, r.data.client_secret)) {
    req.log.warn({ clientId: r.data.client_id }, 'Invalid client credentials in /token');
    sendTokenError(reply, 'invalid_client', 'Invalid client credentials');
    return;
  }

  if (r.data.grant_type === 'authorization_code') {
    return handleAuthCodeExchange(req, reply, r.data);
  } else {
    return handleRefreshGrant(req, reply, r.data);
  }
}

interface AuthCodeBody {
  grant_type: 'authorization_code';
  code: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

async function handleAuthCodeExchange(req: FastifyRequest, reply: FastifyReply, body: AuthCodeBody): Promise<void> {
  const result = await consumeAuthCode(req.server, body.code, body.client_id, body.redirect_uri);
  if (!result) {
    req.log.warn({ requestId: req.requestId }, 'Auth code not found, expired, or redirect_uri mismatch');
    sendTokenError(reply, 'invalid_grant', 'Auth code invalid or expired');
    return;
  }

  // Retrieve yandex_user_id from Redis session cache.
  const { computeCodeHmac } = await import('../services/crypto.service.js');
  const codeHmac = computeCodeHmac(body.code);
  let yandexUserId = '';
  try {
    const meta = await req.server.redis.get(`alice:authcode:meta:${codeHmac}`);
    if (meta) {
      const parsed = JSON.parse(meta) as { yandex_user_id?: string };
      yandexUserId = parsed.yandex_user_id ?? '';
    }
  } catch { /* non-fatal — token issuance proceeds */ }

  const tokens = await issueTokenPair(req.server, {
    hiHouseId:        result.hiHouseId,
    hiOwnerAccountId: result.hiOwnerAccountId,
    yandexUserId,
  }, req.requestId);

  return reply.code(200).send({
    access_token:  tokens.rawAccessToken,
    token_type:    'Bearer',
    expires_in:    tokens.expiresIn,
    refresh_token: tokens.rawRefreshToken,
  } satisfies OAuthTokenResponse);
}

interface RefreshBody {
  grant_type: 'refresh_token';
  refresh_token: string;
  client_id: string;
  client_secret: string;
}

async function handleRefreshGrant(req: FastifyRequest, reply: FastifyReply, body: RefreshBody): Promise<void> {
  const result = await rotateRefreshToken(req.server, body.refresh_token, req.requestId);
  if (!result) {
    sendTokenError(reply, 'invalid_grant', 'Refresh token invalid or expired');
    return;
  }
  return reply.code(200).send({
    access_token:  result.rawAccessToken,
    token_type:    'Bearer',
    expires_in:    result.expiresIn,
    refresh_token: result.rawRefreshToken,
  } satisfies OAuthTokenResponse);
}

// ─── Registration ─────────────────────────────────────────────────────────────

export async function registerOAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/oauth/authorize', handleAuthorize);
  app.get('/oauth/callback',  handleCallback);
  app.post('/oauth/token',    handleToken);
}
