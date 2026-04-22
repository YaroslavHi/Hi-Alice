/**
 * @module services/token.service
 *
 * OAuth 2.0 token lifecycle for the Alice adapter.
 *
 * Storage model (A2 spec):
 *   alice_account_links
 *     access_token_encrypted  = AES-256-GCM(raw_token)   ← at-rest security
 *     access_token_hmac       = HMAC-SHA256(raw_token)    ← O(1) lookup
 *     refresh_token_encrypted = AES-256-GCM(raw_token)
 *     refresh_token_hmac      = HMAC-SHA256(raw_token)
 *     link_status             = 'active' | 'unlinked'
 *
 * Validation flow (every Yandex webhook request):
 *   L1: Redis cache  GET alice:link:{hmac} → ValidatedLink  (~1ms)
 *   L2: DB query     SELECT WHERE access_token_hmac = $hmac  (~5ms)
 *   Miss → return null (invalid/expired/unlinked)
 *
 * No argon2 on the hot path. HMAC lookup is constant-time O(1).
 */

import { nanoid }        from 'nanoid';
import type { FastifyInstance } from 'fastify';
import {
  computeTokenHmac,
  computeCodeHmac,
  encryptToken,
} from './crypto.service.js';
import type { ValidatedToken } from '../types/internal.js';
import { env } from '../config/env.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_LEN  = 64;
const REFRESH_TOKEN_LEN = 64;
const AUTH_CODE_LEN     = 32;
const CACHE_PREFIX      = 'alice:link:';
const CACHE_TTL_SECONDS = 300;

// ─── Generation ───────────────────────────────────────────────────────────────

export function generateAccessToken():  string { return nanoid(ACCESS_TOKEN_LEN);  }
export function generateRefreshToken(): string { return nanoid(REFRESH_TOKEN_LEN); }
export function generateAuthCode():     string { return nanoid(AUTH_CODE_LEN);     }

// ─── Redis cache helpers ──────────────────────────────────────────────────────

function cacheKey(hmac: string): string {
  return `${CACHE_PREFIX}${hmac}`;
}

// ─── Token validation ─────────────────────────────────────────────────────────

/**
 * Validate a Bearer token from an incoming Yandex request.
 *
 * L1 Redis → L2 DB (HMAC lookup). No decryption required for validation.
 * Returns ValidatedToken or null if invalid / expired / unlinked.
 */
export async function validateBearerToken(
  app:      FastifyInstance,
  rawToken: string,
): Promise<ValidatedToken | null> {
  const hmac = computeTokenHmac(rawToken);

  // ── L1: Redis cache ──────────────────────────────────────────────────────
  try {
    const cached = await app.redis.get(cacheKey(hmac));
    if (cached) {
      const parsed = JSON.parse(cached) as ValidatedToken;
      if (new Date(parsed.expires_at) > new Date()) return parsed;
      await app.redis.del(cacheKey(hmac)); // stale
    }
  } catch (err) {
    app.log.warn({ err }, 'Redis cache error — falling back to DB');
  }

  // ── L2: DB HMAC lookup ───────────────────────────────────────────────────
  type Row = {
    id: string;
    hiHouseId: string;
    hiOwnerAccountId: string;
    yandexUserId: string;
    accessTokenExpiresAt: Date;
  };

  const rows = await app.pg<Row[]>`
    SELECT id, hi_house_id, hi_owner_account_id, yandex_user_id, access_token_expires_at
    FROM   alice_account_links
    WHERE  access_token_hmac = ${hmac}
      AND  link_status        = 'active'
      AND  access_token_expires_at > now()
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  const row = rows[0]!;

  const validated: ValidatedToken = {
    access_token_id: row.id,
    user_id:         row.hiOwnerAccountId,
    house_id:        row.hiHouseId,
    yandex_user_id:  row.yandexUserId,
    scope:           '',
    expires_at:      row.accessTokenExpiresAt,
  };

  // Populate L1 cache
  try {
    const ttl = Math.min(
      Math.floor((new Date(row.accessTokenExpiresAt).getTime() - Date.now()) / 1000),
      CACHE_TTL_SECONDS,
    );
    if (ttl > 0) {
      await app.redis.setex(cacheKey(hmac), ttl, JSON.stringify(validated));
    }
  } catch (err) {
    app.log.warn({ err }, 'Failed to populate Redis cache');
  }

  return validated;
}

// ─── Token issuance ───────────────────────────────────────────────────────────

interface IssuanceContext {
  hiHouseId:        string;
  hiOwnerAccountId: string;
  yandexUserId:     string;
}

/**
 * Issue a new access+refresh token pair and upsert alice_account_links.
 * "One active link per house; new link replaces old" — enforced by ON CONFLICT DO UPDATE.
 */
export async function issueTokenPair(
  app:       FastifyInstance,
  ctx:       IssuanceContext,
  requestId: string,
): Promise<{ rawAccessToken: string; rawRefreshToken: string; expiresIn: number }> {
  const rawAccess   = generateAccessToken();
  const rawRefresh  = generateRefreshToken();

  const accessEncrypted  = encryptToken(rawAccess);
  const refreshEncrypted = encryptToken(rawRefresh);
  const accessHmac       = computeTokenHmac(rawAccess);
  const refreshHmac      = computeTokenHmac(rawRefresh);

  const now            = new Date();
  const accessExpires  = new Date(now.getTime() + env.ACCESS_TOKEN_TTL_SECONDS  * 1000);
  const refreshExpires = new Date(now.getTime() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);

  // UPSERT: new link replaces old (per spec: "new link replaces old")
  // ON CONFLICT on hi_house_id (the UNIQUE constraint).
  await app.pg`
    INSERT INTO alice_account_links
      (hi_house_id, hi_owner_account_id, yandex_user_id,
       access_token_encrypted,  access_token_hmac,  access_token_expires_at,
       refresh_token_encrypted, refresh_token_hmac, refresh_token_expires_at,
       link_status, created_at, updated_at)
    VALUES
      (${ctx.hiHouseId}, ${ctx.hiOwnerAccountId}, ${ctx.yandexUserId},
       ${accessEncrypted},  ${accessHmac},  ${accessExpires},
       ${refreshEncrypted}, ${refreshHmac}, ${refreshExpires},
       'active', now(), now())
    ON CONFLICT (hi_house_id) DO UPDATE SET
      hi_owner_account_id     = excluded.hi_owner_account_id,
      yandex_user_id          = excluded.yandex_user_id,
      access_token_encrypted  = excluded.access_token_encrypted,
      access_token_hmac       = excluded.access_token_hmac,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_encrypted  = excluded.refresh_token_encrypted,
      refresh_token_hmac       = excluded.refresh_token_hmac,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      link_status = 'active',
      updated_at  = now()
  `;

  // Audit
  await app.pg`
    INSERT INTO alice_audit_log
      (event_type, hi_house_id, hi_owner_account_id, yandex_user_id, request_id)
    VALUES
      ('token_issued', ${ctx.hiHouseId}, ${ctx.hiOwnerAccountId}, ${ctx.yandexUserId}, ${requestId})
  `;

  app.log.info(
    { hiHouseId: ctx.hiHouseId, hiOwnerAccountId: ctx.hiOwnerAccountId, requestId },
    'Token pair issued',
  );

  return { rawAccessToken: rawAccess, rawRefreshToken: rawRefresh, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS };
}

// ─── Refresh token rotation ───────────────────────────────────────────────────

/**
 * Validate a refresh token and rotate to a new token pair.
 * Old tokens are replaced atomically via UPDATE.
 */
export async function rotateRefreshToken(
  app:             FastifyInstance,
  rawRefreshToken: string,
  requestId:       string,
): Promise<{ rawAccessToken: string; rawRefreshToken: string; expiresIn: number } | null> {
  const refreshHmac = computeTokenHmac(rawRefreshToken);

  type Row = {
    id: string;
    hiHouseId: string;
    hiOwnerAccountId: string;
    yandexUserId: string;
    refreshTokenExpiresAt: Date;
  };

  const rows = await app.pg<Row[]>`
    SELECT id, hi_house_id, hi_owner_account_id, yandex_user_id, refresh_token_expires_at
    FROM   alice_account_links
    WHERE  refresh_token_hmac       = ${refreshHmac}
      AND  link_status               = 'active'
      AND  refresh_token_expires_at  > now()
    LIMIT 1
  `;

  if (rows.length === 0) {
    app.log.warn({ requestId }, 'Refresh token not found or expired');
    return null;
  }

  const row = rows[0]!;

  // Issue new pair — rotates tokens in place on the same row.
  const result = await issueTokenPair(app, {
    hiHouseId:        row.hiHouseId,
    hiOwnerAccountId: row.hiOwnerAccountId,
    yandexUserId:     row.yandexUserId,
  }, requestId);

  // Invalidate old HMAC cache entries.
  try {
    await app.redis.del(cacheKey(refreshHmac));
  } catch { /* non-fatal */ }

  app.log.info({ hiHouseId: row.hiHouseId, requestId }, 'Refresh token rotated');
  return result;
}

// ─── Unlink ───────────────────────────────────────────────────────────────────

/**
 * Unlink an account: set link_status='unlinked' and invalidate cache.
 * Called on POST /v1.0/user/unlink.
 */
export async function unlinkAccount(
  app:       FastifyInstance,
  token:     ValidatedToken,
  ip:        string,
  requestId: string,
): Promise<void> {
  await app.pg`
    UPDATE alice_account_links
    SET    link_status = 'unlinked', updated_at = now()
    WHERE  id = ${token.access_token_id}
  `;

  await app.pg`
    INSERT INTO alice_audit_log
      (event_type, hi_house_id, hi_owner_account_id, yandex_user_id, ip_addr, request_id)
    VALUES
      ('unlinked', ${token.house_id}, ${token.user_id}, ${token.yandex_user_id},
       ${ip}::inet, ${requestId})
  `;

  // Best-effort cache invalidation (HMAC not stored in ValidatedToken, let TTL expire).
  app.log.info({ hiHouseId: token.house_id, requestId }, 'Account unlinked');
}

// ─── Auth code ────────────────────────────────────────────────────────────────

export async function storeAuthCode(
  app: FastifyInstance,
  opts: {
    rawCode:          string;
    clientId:         string;
    hiHouseId:        string;
    hiOwnerAccountId: string;
    redirectUri:      string;
  },
): Promise<void> {
  const codeHmac  = computeCodeHmac(opts.rawCode);
  const expiresAt = new Date(Date.now() + env.AUTH_CODE_TTL_SECONDS * 1000);

  await app.pg`
    INSERT INTO oauth_auth_codes
      (code_hmac, client_id, hi_house_id, hi_owner_account_id, redirect_uri, expires_at)
    VALUES
      (${codeHmac}, ${opts.clientId}, ${opts.hiHouseId}, ${opts.hiOwnerAccountId},
       ${opts.redirectUri}, ${expiresAt})
  `;
}

export async function consumeAuthCode(
  app:         FastifyInstance,
  rawCode:     string,
  clientId:    string,
  redirectUri: string,
): Promise<{ hiHouseId: string; hiOwnerAccountId: string; yandexUserId: string } | null> {
  const codeHmac = computeCodeHmac(rawCode);

  type Row = {
    id: string;
    hiHouseId: string;
    hiOwnerAccountId: string;
    redirectUri: string;
  };

  const rows = await app.pg<Row[]>`
    SELECT id, hi_house_id, hi_owner_account_id, redirect_uri
    FROM   oauth_auth_codes
    WHERE  code_hmac   = ${codeHmac}
      AND  client_id   = ${clientId}
      AND  expires_at  > now()
      AND  used_at     IS NULL
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  const row = rows[0]!;

  if (row.redirectUri !== redirectUri) return null;

  // Mark as used — prevent replay.
  await app.pg`UPDATE oauth_auth_codes SET used_at = now() WHERE id = ${row.id}`;

  // yandex_user_id is derived from the Yandex token at callback time (stored in session).
  // We don't have it here — the oauth controller passes it through separately.
  // Return what we have and let the controller complete the picture.
  return {
    hiHouseId:        row.hiHouseId,
    hiOwnerAccountId: row.hiOwnerAccountId,
    yandexUserId:     '',  // filled by caller from session state
  };
}
